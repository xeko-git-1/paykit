/**
 * GET /admin/transactions — cross-tenant payment_transactions list with
 * filters (provider, status, tenantId, from/to date) + pagination.
 *
 * GET /admin/transactions/:id — detail view (cross-tenant).
 */
import type { AdminGuard } from "@vibecc/paykit";
import { and, count, desc, eq, gte, like, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import { dataJson, errorJson } from "../shared/response.js";
import { adminGuardMiddleware } from "./admin-guard.js";

const listQuerySchema = z.object({
  provider: z.enum(["sepay", "stripe"]).optional(),
  status: z.enum(["pending", "completed", "failed", "refunded", "expired"]).optional(),
  tenantId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface AdminTransactionsRouteDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
}

export function buildAdminTransactionsRoute(deps: AdminTransactionsRouteDeps): Hono {
  const app = new Hono();
  const { db, adminGuard } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.get("/transactions", async (c) => {
    let q: z.infer<typeof listQuerySchema>;
    try {
      q = listQuerySchema.parse(c.req.query());
    } catch (err) {
      return errorJson(
        c,
        400,
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "invalid query",
      );
    }

    const conds = [
      ...(q.provider !== undefined ? [eq(paymentTransactions.provider, q.provider)] : []),
      ...(q.status !== undefined ? [eq(paymentTransactions.status, q.status)] : []),
      ...(q.tenantId !== undefined ? [eq(paymentTransactions.tenantId, q.tenantId)] : []),
      ...(q.from !== undefined ? [gte(paymentTransactions.createdAt, new Date(q.from))] : []),
      ...(q.to !== undefined ? [lt(paymentTransactions.createdAt, new Date(q.to))] : []),
    ];
    if (q.search !== undefined) {
      const searchOr = or(
        like(paymentTransactions.transactionId, `%${q.search}%`),
        like(paymentTransactions.providerRef, `%${q.search}%`),
      );
      if (searchOr !== undefined) conds.push(searchOr);
    }

    const where = conds.length > 0 ? and(...conds) : undefined;
    const offset = (q.page - 1) * q.limit;

    const rows = await db
      .select()
      .from(paymentTransactions)
      .where(where)
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(q.limit)
      .offset(offset);

    const [countRow] = await db.select({ total: count() }).from(paymentTransactions).where(where);
    const total = countRow?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / q.limit));

    return dataJson(c, {
      payments: rows.map((p) => ({
        transactionId: p.transactionId,
        tenantId: p.tenantId,
        ownerId: p.ownerId,
        provider: p.provider,
        amountMicros: p.amountMicros,
        currencyCode: p.currencyCode,
        status: p.status,
        providerRef: p.providerRef,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
      pagination: { page: q.page, limit: q.limit, total, pages },
    });
  });

  app.get("/transactions/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, id))
      .limit(1);
    if (!row) return errorJson(c, 404, "NOT_FOUND", "transaction not found");
    return dataJson(c, {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });

  return app;
}
