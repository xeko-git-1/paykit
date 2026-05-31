/**
 * GET /ledger — paginated ledger entries scoped to current tenant.
 *
 * Query params: entryType, currencyCode, since, until, limit (max 200), offset.
 *
 * Tenant resolved via paykitAuth context (service mode) or TenantResolver (embedded).
 */
import { TenantResolutionError } from "@vibecc/paykit";
import type { TenantResolver } from "@vibecc/paykit";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import { listLedgerEntries } from "../../db/repos/ledger.repo.js";
import { getAuthTenant } from "../../auth/auth-context.js";
import { dataJson, errorJson } from "../shared/response.js";

const ledgerQuerySchema = z.object({
  entryType: z.enum(["credit", "debit", "refund", "manual_adjustment"]).optional(),
  currencyCode: z.enum(["USD", "VND"]).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface LedgerRouteDeps {
  readonly db: DbClient;
  readonly tenantResolver?: TenantResolver;
}

export function buildLedgerRoute(deps: LedgerRouteDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver } = deps;

  app.get("/ledger", async (c) => {
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
      // Service mode with no auth context — fail closed
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    let q: z.infer<typeof ledgerQuerySchema>;
    try {
      q = ledgerQuerySchema.parse(c.req.query());
    } catch (err) {
      return errorJson(
        c,
        400,
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "invalid query",
      );
    }

    const entries = await listLedgerEntries(db, {
      tenantId: tenant.tenantId,
      ...(q.entryType !== undefined ? { entryType: q.entryType } : {}),
      ...(q.currencyCode !== undefined ? { currencyCode: q.currencyCode } : {}),
      ...(q.since !== undefined ? { since: new Date(q.since) } : {}),
      ...(q.until !== undefined ? { until: new Date(q.until) } : {}),
      limit: q.limit,
      offset: q.offset,
    });

    return dataJson(c, {
      entries: entries.map((e) => ({
        entryId: e.entryId,
        entryType: e.entryType,
        amountMicros: e.amountMicros,
        currencyCode: e.currencyCode,
        metadataJson: e.metadataJson,
        createdAt: e.createdAt.toISOString(),
      })),
      pagination: { limit: q.limit, offset: q.offset },
    });
  });

  return app;
}
