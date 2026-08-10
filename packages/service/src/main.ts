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
import { timingSafeEqual } from "node:crypto";
import type { PaymentProviderAdapter } from "@xeko-git-1/paykit";
import {
  type ApiKeyAuthDeps,
  type DbClient,
  JWT_AUDIENCE,
  JWT_ISSUER,
  type JwtSecretLoader,
  apiKeyAuthMiddleware,
  apiKeyRepo,
  authPlaneDispatcher,
  createJwtSecretLoader,
  createPaykit,
  jwtAuthMiddleware,
  paykitDbSchema,
  runtimeConfigRepo,
} from "@xeko-git-1/paykit-server";
import { Hono } from "hono";
import type { Pool } from "pg";
import { serviceErrorHandler } from "./error-handler.js";
import { buildHealthRoutes } from "./health.js";
import { getOpenAPIDocument } from "./v1/openapi.js";
import { buildV1Router } from "./v1/router.js";

/**
 * Constant-time string compare for the admin secret. A plain !== leaks the
 * length of the matching prefix via timing; timingSafeEqual does not. Returns
 * false fast on length mismatch (which timingSafeEqual itself cannot accept).
 */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

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
        if (!secret || !secretsMatch(secret, adminSecret)) {
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

export async function serve(port: number, app: Hono): Promise<{ close: () => Promise<void> }> {
  const { serve: honoServe } = await import("@hono/node-server");
  const server = honoServe({ fetch: app.fetch, port });

  // Surface a bind failure (e.g. EADDRINUSE) as a process exit rather than an
  // unhandled 'error' event that crashes with no context.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`paykit-service: port ${port} is already in use.`);
    } else {
      console.error("paykit-service: server error:", err.message);
    }
    process.exit(1);
  });

  console.log(`paykit-service listening on :${port}`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
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

    // An error on an idle pooled client (e.g. DB restart) emits on the pool;
    // without a listener Node treats it as unhandled and crashes the process.
    // Log and let the pool recreate the connection on next use.
    pool.on("error", (err: Error) => {
      console.error("paykit-service: idle Postgres client error:", err.message);
    });

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

    const server = await serve(config.port, app);

    // The durable queues only mean something if something comes back for them. A
    // webhook the inbox could not match, and a screening whose verdict was
    // inconclusive, are both waiting on this tick; without it a paid customer is
    // never credited and nothing raises an error. Several replicas ticking at once
    // is safe — the claims are guarded UPDATEs, so they divide the work.
    const { startBackgroundDrains } = await import("./background-drains.js");
    const drains = startBackgroundDrains({
      db,
      settlesExactAmount: (provider: string) =>
        providers.find((a) => a.id === provider)?.settlesExactAmount !== false,
      logger: {
        warn: (msg: string, details?: Record<string, unknown>) => {
          console.warn(`paykit-service: ${msg}`, details ?? {});
        },
      },
    });

    // Graceful shutdown: stop accepting connections, then close the pool so
    // in-flight queries finish and the DB sees a clean disconnect. A second
    // signal (or a 10s timeout) forces exit so a hung request cannot wedge it.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        console.error(`paykit-service: second ${signal} — forcing exit.`);
        process.exit(1);
      }
      shuttingDown = true;
      console.log(`paykit-service: ${signal} received — draining…`);
      const forceTimer = setTimeout(() => {
        console.error("paykit-service: drain timed out — forcing exit.");
        process.exit(1);
      }, 10_000);
      forceTimer.unref?.();
      try {
        // Stopped before the pool closes, or a tick in flight queries a dead pool
        // and logs an error that describes nothing but the shutdown itself.
        drains.stop();
        await server.close();
        await pool.end();
        console.log("paykit-service: shutdown complete.");
        process.exit(0);
      } catch (err) {
        console.error(
          "paykit-service: error during shutdown:",
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    return;
  }

  console.error(
    `Unknown command: ${command}. The service image supports only: serve. Run migrations with the paykit CLI (paykit migrate up).`,
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
