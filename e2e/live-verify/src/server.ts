/**
 * Live-verify server — embedded paykit app driven purely by env, for verifying
 * the crypto adapters against REAL provider APIs (sandbox where one exists,
 * production for Binance Pay which has none).
 *
 * Boot order the operator follows (see README.md):
 *   1. docker compose up postgres   (repo root)
 *   2. pnpm --filter @xeko-git-1/paykit-cli ... migrate  (or docker compose migrate)
 *   3. cloudflared tunnel --url http://localhost:4242    → export PUBLIC_BASE_URL
 *   4. pnpm --filter @paykit-e2e/live-verify serve
 *   5. pnpm --filter @paykit-e2e/live-verify verify -- <provider> --amount 5
 *
 * Every route the verify script uses is mounted here:
 *   POST /api/billing/checkout/:provider   (fixed tenant, no auth — local only)
 *   GET  /api/billing/payments | /balance | /ledger
 *   POST /admin/refund                     (X-Admin-Secret header)
 *   POST /webhooks/:provider               (provider-signed; reached via tunnel)
 */
import { serve } from "@hono/node-server";
import { type DbClient, createPaykit, paykitDbSchema } from "@xeko-git-1/paykit-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { Pool } from "pg";
import { buildLiveVerifyAdapters } from "./env-adapters.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://paykit:paykit@localhost:5432/paykit";
const PORT = Number.parseInt(process.env.PORT ?? "4242", 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "live-verify-admin";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

export const LIVE_VERIFY_TENANT = { tenantId: "tenant_live_verify", ownerId: "user_live_verify" };

async function main(): Promise<void> {
  if (!PUBLIC_BASE_URL) {
    console.warn(
      "live-verify: PUBLIC_BASE_URL is not set — providers cannot deliver webhooks.\n" +
        "  Start a tunnel first, e.g.:  cloudflared tunnel --url http://localhost:4242\n" +
        "  then:  export PUBLIC_BASE_URL=https://<random>.trycloudflare.com",
    );
  }

  const { adapters, notes } = await buildLiveVerifyAdapters({
    env: process.env as Record<string, string | undefined>,
    ...(PUBLIC_BASE_URL ? { publicBaseUrl: PUBLIC_BASE_URL } : {}),
  });
  if (adapters.length === 0) {
    console.error(
      "live-verify: no provider creds found in env. Copy .env.example, fill at least one provider, and re-run.",
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  pool.on("error", (err: Error) => console.error("live-verify: idle pg client error:", err.message));
  const db = drizzle(pool, { schema: paykitDbSchema }) as unknown as DbClient;

  const paykit = await createPaykit({
    db,
    providers: adapters,
    tenantResolver: async () => LIVE_VERIFY_TENANT,
    adminGuard: async (req: unknown) => {
      const request = req as Request;
      const secret = request.headers.get("X-Admin-Secret");
      if (secret !== ADMIN_SECRET) return { allowed: false };
      return { allowed: true, adminUserId: "live-verify", role: "super" };
    },
  });

  const app = new Hono();
  app.get("/return", (c) =>
    c.html("<h1>Payment flow returned.</h1><p>Check the verify script output.</p>"),
  );
  app.route("/api/billing", paykit.routes());
  app.route("/webhooks", paykit.webhookRoutes());
  app.route("/admin", paykit.adminRoutes());

  serve({ fetch: app.fetch, port: PORT });
  console.log(`live-verify listening on :${PORT}`);
  console.log(`  public base: ${PUBLIC_BASE_URL ?? "(NO TUNNEL — webhooks will not arrive)"}`);
  console.log("  providers:");
  for (const note of notes) console.log(`    - ${note}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
