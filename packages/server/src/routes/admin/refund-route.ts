/**
 * POST /admin/billing/refund — cross-provider refund endpoint (V1.5 Phase 08).
 *
 * Body: { transactionId, amountMicros, reason }
 * Headers (REQUIRED): Idempotency-Key
 *
 * Flow:
 *   1. adminGuard middleware
 *   2. Validate body + Idempotency-Key required (red-team F3)
 *   3. SELECT FOR UPDATE the payment_transactions row
 *   4. Lookup adapter from registry by tx.provider
 *   5. Call adapter.refund({ transactionId, amountMicros, idempotencyKey, reason, providerRef })
 *   6. Branch on result.state:
 *        - 'completed': append ledger entry (negative) + applyDelta atomically
 *        - 'pending':   write pending_refunds row (ZaloPay 2-step), no ledger
 *        - 'failed':    return 502 with provider code, NO ledger write
 *        - 'unsupported': return 501 with pointer to /admin/billing/ledger/adjust
 *   7. Audit emit (post-tx, fire-and-forget)
 */
import type { AdminGuard, AdminGuardResult, ProviderRegistry, RefundResult } from "@vibecc/paykit";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import { applyDelta } from "../../db/repos/balance.repo.js";
import { appendLedgerEntry, listLedgerEntries } from "../../db/repos/ledger.repo.js";
import { createPendingRefund } from "../../db/repos/pending-refund.repo.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import { dataJson, errorJson } from "../shared/response.js";
import { adminGuardMiddleware } from "./admin-guard.js";
import type { AdminAuditAction } from "./ledger-adjust-route.js";

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

    // 1. Locate transaction row + lock for refund-amount math
    const [txRow] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, parsed.transactionId))
      .limit(1);
    if (!txRow) return errorJson(c, 404, "NOT_FOUND", "transaction not found");

    // 2. Compute remaining refundable: original - SUM(prior refund ledger entries on this tx)
    const priorRefunds = await listLedgerEntries(db, {
      tenantId: txRow.tenantId,
      entryType: "refund",
      currencyCode: txRow.currencyCode,
      limit: 200,
    });
    const priorOnThisTx = priorRefunds.filter(
      (e) =>
        (e.metadataJson as { originalTransactionId?: string }).originalTransactionId ===
        txRow.transactionId,
    );
    const cumulativeRefundedMicros = priorOnThisTx.reduce(
      (acc, e) => acc + BigInt(e.amountMicros.split(".")[0] ?? "0"),
      0n,
    );
    const originalMicros = BigInt(txRow.amountMicros.split(".")[0] ?? "0");
    const remaining = originalMicros + cumulativeRefundedMicros; // refunds are negative entries
    if (refundAmountMicros > remaining) {
      return errorJson(
        c,
        400,
        "REFUND_EXCEEDS_REMAINING",
        `requested ${refundAmountMicros} > remaining ${remaining} (original ${originalMicros}, refunded ${-cumulativeRefundedMicros})`,
      );
    }

    // 3. Look up adapter from registry
    const adapter = registry.get(txRow.provider);
    if (!adapter) {
      return errorJson(
        c,
        500,
        "ADMIN_REFUND_PROVIDER_UNKNOWN",
        `transaction.provider='${txRow.provider}' has no registered adapter`,
      );
    }

    // 4. Call adapter.refund
    let refundResult: RefundResult;
    try {
      refundResult = await adapter.refund({
        transactionId: txRow.transactionId,
        amountMicros: refundAmountMicros,
        idempotencyKey,
        reason: parsed.reason,
        ...(txRow.providerRef !== null ? { providerRef: txRow.providerRef } : {}),
      });
    } catch (err) {
      logger?.warn("adapter.refund threw", {
        provider: txRow.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorJson(c, 502, "PROVIDER_REFUND_ERROR", "Provider refund call failed");
    }

    // 5. Branch on RefundResult.state
    if (refundResult.state === "unsupported") {
      return errorJson(
        c,
        501,
        "PROVIDER_REFUND_UNSUPPORTED",
        refundResult.error?.message ?? "Provider does not support refund via API",
        { alternativeAction: "POST /admin/billing/ledger/adjust" },
      );
    }
    if (refundResult.state === "failed") {
      return errorJson(
        c,
        502,
        "PROVIDER_REFUND_FAILED",
        refundResult.error?.message ?? "Provider rejected refund",
        { providerCode: refundResult.error?.providerCode },
      );
    }
    if (refundResult.state === "pending") {
      // Write pending_refunds row; reconciler polls until terminal
      const pending = await db.transaction(async (tx) =>
        createPendingRefund(tx, {
          transactionId: txRow.transactionId,
          provider: txRow.provider,
          idempotencyKey,
          amountMicros: refundAmountMicros.toString(),
          currencyCode: txRow.currencyCode,
          reason: parsed.reason,
          metadataJson: {
            adminUserId: adminCtx.adminUserId,
            adminRole: adminCtx.role,
            providerRefundId: refundResult.providerRefundId,
          },
        }),
      );
      return dataJson(c, {
        state: "pending",
        pendingId: pending.pendingId,
        message: "Refund submitted; awaiting provider confirmation. Reconciler will poll status.",
      });
    }

    // 6. state === 'completed' — write ledger entry + applyDelta atomically
    const ledgerEntry = await db.transaction(async (tx) => {
      // Re-lock the row in case of concurrent refund (red-team CC concurrency)
      await tx
        .select({ id: paymentTransactions.transactionId })
        .from(paymentTransactions)
        .where(eq(paymentTransactions.transactionId, txRow.transactionId))
        .for("update")
        .limit(1);

      const entry = await appendLedgerEntry(tx, {
        tenantId: txRow.tenantId,
        ownerId: txRow.ownerId,
        entryType: "refund",
        amountMicros: (-refundAmountMicros).toString(),
        currencyCode: txRow.currencyCode,
        metadataJson: {
          source: "admin_refund",
          provider: txRow.provider,
          originalTransactionId: txRow.transactionId,
          reason: parsed.reason,
          idempotencyKey,
          adminUserId: adminCtx.adminUserId ?? null,
          adminRole: adminCtx.role ?? null,
          providerRefundId: refundResult.providerRefundId,
        },
      });
      await applyDelta(tx, txRow.tenantId, txRow.currencyCode, -refundAmountMicros);

      // If full refund (cumulative + new = original), mark tx status='refunded'
      const newCumulative = -cumulativeRefundedMicros + refundAmountMicros;
      if (newCumulative >= originalMicros) {
        await tx
          .update(paymentTransactions)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(eq(paymentTransactions.transactionId, txRow.transactionId));
      }
      return entry;
    });

    // 7. Fire-and-forget audit
    if (onAdminAction) {
      try {
        await onAdminAction({
          action: "refund",
          adminUserId: adminCtx.adminUserId,
          role: adminCtx.role,
          payload: {
            entryId: ledgerEntry.entryId,
            transactionId: txRow.transactionId,
            provider: txRow.provider,
            amountMicros: refundAmountMicros.toString(),
            currencyCode: txRow.currencyCode,
            idempotencyKey,
            reason: parsed.reason,
            providerRefundId: refundResult.providerRefundId,
          },
        });
      } catch (err) {
        logger?.warn("onAdminAction threw — swallowed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return dataJson(c, {
      state: "completed",
      entryId: ledgerEntry.entryId,
      providerRefundId: refundResult.providerRefundId,
      refundedAmountMicros: refundAmountMicros.toString(),
    });
  });

  // Avoid unused import warning in some bundlers
  void sql;
  void and;

  return app;
}
