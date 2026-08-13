/**
 * GET /admin/refunds/overdue-webhooks — the operator's queue of refunds whose
 * confirmation webhook never came.
 *
 * A `pending_webhook` refund moves no money until the provider's webhook lands;
 * a row past the timeout needs a human to ask the provider what happened and
 * settle it per docs/refund-flows.md (usually via /ledger/adjust). The list is
 * computed live from `payment_transactions`, not from the sweeper's marker, so
 * a refund is visible the moment it crosses the threshold even if no sweep has
 * ticked since. `overdueAt` says whether (and when) the sweeper already
 * reported it — null means the alert has not fired yet.
 *
 * Query: olderThanHours (default 24, matching the sweeper), limit, offset.
 */
import type { AdminGuard } from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { listOverdueRefundWebhooks } from "@xeko-git-1/paykit-auth-core/db/repos/refund-overdue.repo.js";
import { Hono } from "hono";
import { z } from "zod";
import { dataJson, errorJson } from "../shared/response.js";
import { adminGuardMiddleware } from "./admin-guard.js";

const querySchema = z.object({
  olderThanHours: z.coerce
    .number()
    .min(0)
    .max(24 * 365)
    .default(24),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface AdminRefundOverdueDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
  readonly now?: () => Date;
}

export function buildAdminRefundOverdueRoute(deps: AdminRefundOverdueDeps): Hono {
  const app = new Hono();
  const { db, adminGuard } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.get("/refunds/overdue-webhooks", async (c) => {
    let q: z.infer<typeof querySchema>;
    try {
      q = querySchema.parse(c.req.query());
    } catch (err) {
      return errorJson(
        c,
        400,
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "invalid query",
      );
    }

    const now = deps.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - q.olderThanHours * 60 * 60 * 1000);
    const rows = await listOverdueRefundWebhooks(db, {
      cutoff,
      limit: q.limit,
      offset: q.offset,
    });

    return dataJson(c, {
      refunds: rows.map((r) => ({
        transactionId: r.transactionId,
        tenantId: r.tenantId,
        provider: r.provider,
        amountMicros: r.amountMicros,
        currencyCode: r.currencyCode,
        pendingSince: r.pendingSince.toISOString(),
        overdueAt: r.overdueAt,
      })),
      pagination: { limit: q.limit, offset: q.offset },
    });
  });

  return app;
}
