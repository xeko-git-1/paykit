/**
 * POST /admin/billing/refund — cross-provider refund endpoint (V1.5 Phase 08).
 *
 * Body: { transactionId, amountMicros, reason }
 * Headers (REQUIRED): Idempotency-Key
 *
 * Flow:
 *   1. adminGuard middleware
 *   2. Validate body + Idempotency-Key required
 *   3. SELECT the payment_transactions row
 *   4. Delegate to refund-core (guard-agnostic shared logic)
 *   5. Map core result to HTTP response
 *   6. Audit emit (post-tx, fire-and-forget)
 */
import type { AdminGuard, AdminGuardResult, ProviderRegistry } from "@xeko-git-1/paykit";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { paymentTransactions } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";
import { dataJson, errorJson } from "../shared/response.js";
import { adminGuardMiddleware } from "./admin-guard.js";
import type { AdminAuditAction } from "./ledger-adjust-route.js";
import { executeRefund } from "../../services/refund-core.js";

const refundBodySchema = z.object({
  transactionId: z.string().uuid(),
  amountMicros: z.string().regex(/^\d+$/),
  reason: z.string().min(3).max(500),
});

export interface AdminRefundRouteDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
  readonly registry: ProviderRegistry;
  readonly onAdminAction?: (action: AdminAuditAction) => void | Promise<void>;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildAdminRefundRoute(deps: AdminRefundRouteDeps): Hono {
  const app = new Hono();
  const { db, adminGuard, registry, onAdminAction, logger } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.post("/refund", async (c: Context) => {
    const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
    if (idempotencyKey === "" || idempotencyKey.length < 8) {
      return errorJson(
        c,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "POST /admin/billing/refund requires Idempotency-Key header (>= 8 chars). " +
          "Generate a UUID per refund attempt; same key returns same result.",
      );
    }

    let parsed: z.infer<typeof refundBodySchema>;
    try {
      const body = await c.req.json();
      parsed = refundBodySchema.parse(body);
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    const refundAmountMicros = BigInt(parsed.amountMicros);
    const adminCtx = c.get("adminContext") as AdminGuardResult;

    // Locate transaction row (admin route does NOT filter by tenant — trusted operator plane)
    const [txRow] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, parsed.transactionId))
      .limit(1);
    if (!txRow) return errorJson(c, 404, "NOT_FOUND", "transaction not found");

    // Delegate to guard-agnostic refund core
    const actor = {
      kind: "admin" as const,
      adminUserId: adminCtx.adminUserId ?? "unknown",
      role: adminCtx.role ?? "unknown",
    };
    const result = await executeRefund(
      { db, registry, logger },
      actor,
      { txRow, amountMicros: refundAmountMicros, idempotencyKey, reason: parsed.reason },
    );

    // Map core result to HTTP response
    if (result.state === "exceeds_remaining") {
      return errorJson(
        c,
        400,
        "REFUND_EXCEEDS_REMAINING",
        `requested ${result.requested} > remaining ${result.remaining}`,
      );
    }
    if (result.state === "provider_unknown") {
      return errorJson(
        c,
        500,
        "ADMIN_REFUND_PROVIDER_UNKNOWN",
        `transaction.provider='${result.provider}' has no registered adapter`,
      );
    }
    if (result.state === "unsupported") {
      return errorJson(c, 501, result.code, result.message, {
        alternativeAction: "POST /admin/billing/ledger/adjust",
      });
    }
    if (result.state === "failed") {
      return errorJson(c, 502, result.code, result.message);
    }
    if (result.state === "pending") {
      return dataJson(c, {
        state: "pending",
        pendingId: result.pendingId,
        message: "Refund submitted; awaiting provider confirmation. Reconciler will poll status.",
      });
    }
    if (result.state === "pending_webhook") {
      // Fire-and-forget audit for async refund
      if (onAdminAction) {
        try {
          await onAdminAction({
            action: "refund",
            adminUserId: adminCtx.adminUserId,
            role: adminCtx.role,
            payload: {
              state: "pending_webhook",
              transactionId: txRow.transactionId,
              provider: txRow.provider,
              amountMicros: refundAmountMicros.toString(),
              currencyCode: txRow.currencyCode,
              idempotencyKey,
              reason: parsed.reason,
              providerCode: result.providerCode,
            },
          });
        } catch (err) {
          logger?.warn("onAdminAction threw — swallowed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      c.status(202);
      return c.json({
        data: {
          state: "pending_webhook",
          transactionId: result.transactionId,
          message:
            "Refund accepted by provider asynchronously; ledger entry written when webhook fires payment.refunded.",
          providerCode: result.providerCode ?? null,
        },
      });
    }

    // state === 'completed'
    // Fire-and-forget audit
    if (onAdminAction) {
      try {
        await onAdminAction({
          action: "refund",
          adminUserId: adminCtx.adminUserId,
          role: adminCtx.role,
          payload: {
            entryId: result.entryId,
            transactionId: txRow.transactionId,
            provider: txRow.provider,
            amountMicros: refundAmountMicros.toString(),
            currencyCode: txRow.currencyCode,
            idempotencyKey,
            reason: parsed.reason,
            providerRefundId: result.providerRefundId,
          },
        });
      } catch (err) {
        logger?.warn("onAdminAction threw — swallowed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return dataJson(c, {
      state: result.inserted ? "completed" : "duplicate",
      entryId: result.entryId,
      providerRefundId: result.providerRefundId,
      refundedAmountMicros: refundAmountMicros.toString(),
    });
  });

  return app;
}
