import type { PaymentProviderAdapter } from "@vibecc/paykit";
import {
  type ApiKeyAuthDeps,
  type DbClient,
  type JwtSecretLoader,
  apiKeyAuthMiddleware,
  apiKeyRepo,
  authPlaneDispatcher,
  createJwtSecretLoader,
  createPaykit,
  jwtAuthMiddleware,
  JWT_AUDIENCE,
  JWT_ISSUER,
  paykitDbSchema,
  runtimeConfigRepo,
} from "@vibecc/paykit-server";
/**
 * Service shell entrypoint — builds the Hono app and optionally starts
 * the HTTP server. Separated into buildServiceApp (testable via fetch)
 * and serve (opens socket on PORT).
 *
 * Route structure (webhooks mount above auth glob so provider callbacks
 * are never rejected):
 *   /healthz, /readyz  — no auth, health probes
 *   /webhooks/*        — top-level, no auth (signature verified inside adapter)
 *   /v1/*              — apiKeyAuthMiddleware enforced
 *   /v1/admin/*        — adminGuard (env-based for V4.0)
 */
import { Hono } from "hono";
import type { Pool } from "pg";
import { buildHealthRoutes } from "./health.js";
import { buildV1Router } from "./v1/router.js";
import { getOpenAPIDocument } from "./v1/openapi.js";
import { serviceErrorHandler } from "./error-handler.js";

// Re-exported for SDK generation + spec-snapshot tests (public API surface).
export { getOpenAPIDocument } from "./v1/openapi.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildServiceAppDeps {
  readonly db: DbClient;
  readonly providers: readonly PaymentProviderAdapter[];
  readonly jwtSecretLoader: JwtSecretLoader;
  readonly pool?: Pool | null | undefined;
  readonly adminSecret?: string | undefined;
}

// ---------------------------------------------------------------------------
// buildServiceApp — returns Hono instance, testable via app.request()
// ---------------------------------------------------------------------------

export async function buildServiceApp(deps: BuildServiceAppDeps): Promise<Hono> {
  const { db, providers, jwtSecretLoader, pool = null, adminSecret } = deps;

  const app = new Hono();

  // Convert any uncaught route error into the standard envelope (no stack leak).
  app.onError(serviceErrorHandler);

  // 1. Health routes — no auth, mounted first
  const healthApp = buildHealthRoutes({ pool });
  app.route("/", healthApp);

  // 2. Webhooks — top-level, structurally outside /v1 auth glob
  const paykit = await createPaykit({
    db,
    providers: providers as PaymentProviderAdapter[],
    // Safety net: service mode has no real tenant resolver. Auth middleware
    // is the only tenant source. If any code path accidentally calls this,
    // it throws immediately rather than returning stale/wrong data.
    tenantResolver: () => {
      throw new Error("Service mode: tenant resolved from auth context only");
    },
  });
  app.route("/webhooks", paykit.webhookRoutes());

  // 3. OpenAPI spec — mounted BEFORE the /v1 auth glob so the spec is public
  //    documentation reachable without a key (same posture as /healthz).
  app.get("/v1/openapi.json", (c) => c.json(getOpenAPIDocument()));

  // 4. Auth on /v1/* — dual plane. api-key (pk_ tokens) for s2s; jwt for
  //    admin/dashboard (e.g. POST /v1/api-keys mint). A dispatcher routes by
  //    token shape so the two mutually-exclusive middlewares coexist: exactly
  //    one plane runs per request.
  const apiKeyDeps: ApiKeyAuthDeps = {
    db,
    findByHash: apiKeyRepo.findByHash,
    touchLastUsed: apiKeyRepo.touchLastUsed,
    resolveMerchantTenant: async (merchantId: string) => {
      // V4.0: merchantId IS the tenantId (single-tenant-per-merchant)
      return { tenantId: merchantId, ownerId: merchantId };
    },
  };
  const apiKeyPlane = apiKeyAuthMiddleware(apiKeyDeps);
  const jwtPlane = jwtAuthMiddleware({
    loadSecret: jwtSecretLoader,
    expectedIssuer: JWT_ISSUER,
    expectedAudience: JWT_AUDIENCE,
  });
  app.use("/v1/*", authPlaneDispatcher({ apiKey: apiKeyPlane, jwt: jwtPlane }));

  // 5. Service routes under /v1 (tenant from paykitAuth, not resolver)
  app.route("/v1", paykit.serviceRoutes());

  // 6. V1 public API surface (scope-gated, rate-limited, OpenAPI-described)
  const v1Router = buildV1Router({ db, registry: paykit.registry });
  app.route("/v1", v1Router);

  // 7. Admin routes under /v1/admin (env-based guard for V4.0)
  if (adminSecret) {
    const adminPaykit = await createPaykit({
      db,
      providers: providers as PaymentProviderAdapter[],
      adminGuard: async (req: unknown) => {
        const request = req as Request;
        const secret = request.headers.get("X-Admin-Secret");
        if (secret !== adminSecret) {
          return { allowed: false };
        }
        return { allowed: true, adminUserId: "env-admin", role: "super" };
      },
      tenantResolver: () => {
        throw new Error("Service mode: tenant resolved from auth context only");
      },
    });
    app.route("/v1/admin", adminPaykit.adminRoutes());
  }

  return app;
}

// ---------------------------------------------------------------------------
// serve — opens HTTP socket (not used in tests)
// ---------------------------------------------------------------------------

export async function serve(port: number, app: Hono): Promise<void> {
  const { serve: honoServe } = await import("@hono/node-server");
  honoServe({ fetch: app.fetch, port });
  console.log(`paykit-service listening on :${port}`);
}

// ---------------------------------------------------------------------------
// CLI dispatch — service image runs `serve` only. Migrations are applied by
// the paykit CLI bin directly (compose init-container), never from this
// process: keeps schema changes out of the request-serving image and avoids
// shelling out with an interpolated DSN.
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  if (command === "serve") {
    const { parseServiceConfig } = await import("./config.js");
    const { buildAdaptersFromConfig } = await import("./adapters-from-env.js");

    // Parse and validate env
    const config = parseServiceConfig(process.env as Record<string, string | undefined>);

    // Connect to Postgres
    const { Pool: PgPool } = await import("pg");
    const pool = new PgPool({ connectionString: config.databaseUrl });

    // Build Drizzle client WITH schema so the relational query API (db.query.*)
    // works — repos like balance.repo use db.query.balanceProjections.
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const db = drizzle(pool, { schema: paykitDbSchema }) as unknown as DbClient;

    // Bootstrap JWT secret loader from runtime_config
    const jwtSecretLoader = createJwtSecretLoader({
      getKey: runtimeConfigRepo.getKey as (
        db: unknown,
        key: string,
      ) => Promise<{ value: string } | undefined>,
      claimKey: runtimeConfigRepo.claimKey as (
        db: unknown,
        input: { key: string; value: string; expiresAt?: Date | null },
      ) => Promise<{ value: string }>,
      db,
    });

    // Build adapters from env
    const providers = await buildAdaptersFromConfig(config);

    // Build and serve
    const app = await buildServiceApp({
      db,
      providers,
      jwtSecretLoader,
      pool,
      adminSecret: config.adminSecret,
    });

    await serve(config.port, app);
    return;
  }

  console.error(
    `Unknown command: ${command}. The service image supports only: serve. ` +
      "Run migrations with the paykit CLI (node packages/cli/dist/bin/paykit.js migrate up).",
  );
  process.exit(1);
}

// Auto-run when executed directly (not imported for testing)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/main.js") || process.argv[1].endsWith("/main.ts"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
