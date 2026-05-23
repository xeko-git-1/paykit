/**
 * GET /balance — current per-currency balance from projection.
 *   → returns { balances: [{currencyCode, currentBalanceMicros}, ...] }
 *
 * GET /balance/computed — recomputes per-currency totals from ledger entries.
 *   For reconciliation; should equal projection.
 *
 * Both endpoints scope by tenantId resolved via TenantResolver.
 * Webhook routes do NOT call this — they read tenancy from the locked row.
 */
import { TenantResolutionError } from "@vibecc/paykit";
import type { TenantResolver } from "@vibecc/paykit";
import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { listBalancesByTenant } from "../../db/repos/balance.repo.js";
import { computeBalancesByTenant } from "../../db/repos/ledger.repo.js";
import { dataJson, errorJson } from "../shared/response.js";

export interface BalanceRouteDeps {
  readonly db: DbClient;
  readonly tenantResolver: TenantResolver;
}

export function buildBalanceRoute(deps: BalanceRouteDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver } = deps;

  app.get("/balance", async (c) => {
    let tenant: { tenantId: string; ownerId: string };
    try {
      tenant = await tenantResolver(c.req.raw);
    } catch (err) {
      if (err instanceof TenantResolutionError) {
        return errorJson(c, 401, err.code, err.message);
      }
      return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
    }
    const rows = await listBalancesByTenant(db, tenant.tenantId);
    return dataJson(c, {
      balances: rows.map((r) => ({
        currencyCode: r.currencyCode,
        currentBalanceMicros: r.currentBalanceMicros,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  });

  app.get("/balance/computed", async (c) => {
    let tenant: { tenantId: string; ownerId: string };
    try {
      tenant = await tenantResolver(c.req.raw);
    } catch (err) {
      if (err instanceof TenantResolutionError) {
        return errorJson(c, 401, err.code, err.message);
      }
      return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
    }
    const rows = await computeBalancesByTenant(db, tenant.tenantId);
    return dataJson(c, { balances: rows });
  });

  return app;
}
