/**
 * GET /balance — current per-currency balance from projection.
 *   → returns { balances: [{currencyCode, currentBalanceMicros}, ...] }
 *
 * GET /balance/computed — recomputes per-currency totals from ledger entries.
 *   For reconciliation; should equal projection.
 *
 * Both endpoints scope by tenantId resolved via either:
 * - paykitAuth context (service mode — auth middleware upstream)
 * - TenantResolver callback (embedded mode — consumer injects resolver)
 *
 * Webhook routes do NOT call this — they read tenancy from the locked row.
 */
import { TenantResolutionError } from "@vibecc/paykit";
import type { TenantResolver } from "@vibecc/paykit";
import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { listBalancesByTenant } from "../../db/repos/balance.repo.js";
import { computeBalancesByTenant } from "../../db/repos/ledger.repo.js";
import { getAuthTenant } from "../../auth/auth-context.js";
import { dataJson, errorJson } from "../shared/response.js";

export interface BalanceRouteDeps {
  readonly db: DbClient;
  readonly tenantResolver?: TenantResolver;
}

export function buildBalanceRoute(deps: BalanceRouteDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver } = deps;

  app.get("/balance", async (c) => {
    let tenant: { tenantId: string; ownerId: string };

    // Service mode: read from auth context (fail-closed — no header fallback)
    const authTenant = getAuthTenant(c);
    if (authTenant) {
      tenant = authTenant;
    } else if (tenantResolver) {
      // Embedded mode: use consumer-provided resolver
      try {
        tenant = await tenantResolver(c.req.raw);
      } catch (err) {
        if (err instanceof TenantResolutionError) {
          return errorJson(c, 401, err.code, err.message);
        }
        return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
      }
    } else {
      // Service mode with no auth context — fail closed
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
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

    const authTenant = getAuthTenant(c);
    if (authTenant) {
      tenant = authTenant;
    } else if (tenantResolver) {
      try {
        tenant = await tenantResolver(c.req.raw);
      } catch (err) {
        if (err instanceof TenantResolutionError) {
          return errorJson(c, 401, err.code, err.message);
        }
        return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
      }
    } else {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    const rows = await computeBalancesByTenant(db, tenant.tenantId);
    return dataJson(c, { balances: rows });
  });

  return app;
}
