/**
 * GET /payments — payment_transactions list with filters + summary stats.
 *
 * Query: from, to, status, page (1-based), limit (max 100).
 * Summary covers date range only (NOT filtered by status), matching VibeCC parity.
 *
 * Tenant resolved via paykitAuth context (service mode) or TenantResolver (embedded).
 */
import { TenantResolutionError } from "@vibecc/paykit";
import type { TenantResolver } from "@vibecc/paykit";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import { getAuthTenant } from "../../auth/auth-context.js";
import { dataJson, errorJson } from "../shared/response.js";

const paymentQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.enum(["pending", "completed", "failed", "refunded", "expired"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface PaymentHistoryRouteDeps {
  readonly db: DbClient;
  readonly tenantResolver?: TenantResolver;
}

export function buildPaymentHistoryRoute(deps: PaymentHistoryRouteDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver } = deps;

  app.get("/payments", async (c) => {
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

    let q: z.infer<typeof paymentQuerySchema>;
    try {
      q = paymentQuerySchema.parse(c.req.query());
    } catch (err) {
      return errorJson(
        c,
        400,
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "invalid query",
      );
    }

    const dateConds = [
      eq(paymentTransactions.tenantId, tenant.tenantId),
      ...(q.from !== undefined ? [gte(paymentTransactions.createdAt, new Date(q.from))] : []),
      ...(q.to !== undefined ? [lt(paymentTransactions.createdAt, new Date(q.to))] : []),
    ];
    const listConds = [
      ...dateConds,
      ...(q.status !== undefined ? [eq(paymentTransactions.status, q.status)] : []),
    ];

    const offset = (q.page - 1) * q.limit;
    const rows = await db
      .select()
      .from(paymentTransactions)
      .where(and(...listConds))
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(q.limit)
      .offset(offset);

    const [countRow] = await db
      .select({ total: count() })
      .from(paymentTransactions)
      .where(and(...listConds));
    const total = countRow?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / q.limit));

    // Summary covers date range only (no status filter, parity with VibeCC).
    const [summaryRow] = await db
      .select({
        totalAmountMicros: sql<string>`COALESCE(SUM(${paymentTransactions.amountMicros}), 0)::text`,
        totalTransactions: sql<number>`COUNT(*)::int`,
        completedTransactions: sql<number>`COUNT(*) FILTER (WHERE ${paymentTransactions.status} = 'completed')::int`,
      })
      .from(paymentTransactions)
      .where(and(...dateConds));

    return dataJson(c, {
      payments: rows.map((p) => ({
        transactionId: p.transactionId,
        provider: p.provider,
        amountMicros: p.amountMicros,
        currencyCode: p.currencyCode,
        status: p.status,
        providerRef: p.providerRef,
        createdAt: p.createdAt.toISOString(),
      })),
      summary: {
        totalAmountMicros: summaryRow?.totalAmountMicros ?? "0",
        totalTransactions: summaryRow?.totalTransactions ?? 0,
        completedTransactions: summaryRow?.completedTransactions ?? 0,
      },
      pagination: { page: q.page, limit: q.limit, total, pages },
    });
  });

  return app;
}
