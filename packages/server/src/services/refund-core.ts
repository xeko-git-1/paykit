/**
 * Guard-agnostic refund core — shared business logic for both admin and
 * merchant (API-key) refund paths.
 *
 * Accepts an actor (admin or merchant) and tenantId, performs:
 *   1. Locate transaction row (caller provides pre-fetched row or ID)
 *   2. Compute remaining refundable amount
 *   3. Call adapter.refund via registry
 *   4. Branch on result state (completed/pending/pending_webhook/failed/unsupported)
 *   5. Write ledger entry + applyDelta atomically on completion
 *
 * Does NOT handle auth guards, plane checks, or ownership validation —
 * those are the caller's responsibility.
 */
import type { ProviderRegistry, RefundResult } from "@vibecc/paykit";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { applyDelta } from "../db/repos/balance.repo.js";
import { appendLedgerEntryIdempotent, listLedgerEntries } from "../db/repos/ledger.repo.js";
import { createPendingRefund } from "../db/repos/pending-refund.repo.js";
import { paymentTransactions } from "../db/schema/payment-transactions.js";
import type { PaymentTransaction } from "../db/schema/payment-transactions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefundActor =
  | { kind: "admin"; adminUserId: string; role: string }
  | { kind: "merchant"; merchantId: string };

export interface RefundCoreInput {
  readonly txRow: PaymentTransaction;
  readonly amountMicros: bigint;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface RefundCoreDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void } | undefined;
}

export type RefundCoreResult =
  | { state: "completed"; entryId: string; providerRefundId?: string; inserted: boolean }
  | { state: "pending"; pendingId: string }
  | { state: "pending_webhook"; transactionId: string; providerCode?: string }
  | { state: "failed"; statusCode: number; code: string; message: string }
  | { state: "unsupported"; statusCode: number; code: string; message: string }
  | { state: "exceeds_remaining"; remaining: bigint; requested: bigint }
  | { state: "provider_unknown"; provider: string };

// ---------------------------------------------------------------------------
// Core refund logic
// ---------------------------------------------------------------------------

export async function executeRefund(
  deps: RefundCoreDeps,
  actor: RefundActor,
  input: RefundCoreInput,
): Promise<RefundCoreResult> {
  const { db, registry, logger } = deps;
  const { txRow, amountMicros, idempotencyKey, reason } = input;

  // 1. Compute remaining refundable: original - SUM(prior refund ledger entries)
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

  if (amountMicros > remaining) {
    return { state: "exceeds_remaining", remaining, requested: amountMicros };
  }

  // 2. Look up adapter from registry
  const adapter = registry.get(txRow.provider);
  if (!adapter) {
    return { state: "provider_unknown", provider: txRow.provider };
  }

  // 3. Call adapter.refund
  let refundResult: RefundResult;
  try {
    refundResult = await adapter.refund({
      transactionId: txRow.transactionId,
      amountMicros,
      idempotencyKey,
      reason,
      ...(txRow.providerRef !== null ? { providerRef: txRow.providerRef } : {}),
    });
  } catch (err) {
    logger?.warn("adapter.refund threw", {
      provider: txRow.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return { state: "failed", statusCode: 502, code: "PROVIDER_REFUND_ERROR", message: "Provider refund call failed" };
  }

  // 4. Branch on RefundResult.state
  if (refundResult.state === "unsupported") {
    return {
      state: "unsupported",
      statusCode: 501,
      code: "PROVIDER_REFUND_UNSUPPORTED",
      message: refundResult.error?.message ?? "Provider does not support refund via API",
    };
  }

  if (refundResult.state === "failed") {
    return {
      state: "failed",
      statusCode: 502,
      code: "PROVIDER_REFUND_FAILED",
      message: refundResult.error?.message ?? "Provider rejected refund",
    };
  }

  if (refundResult.state === "pending") {
    const metadataJson =
      actor.kind === "admin"
        ? { adminUserId: actor.adminUserId, adminRole: actor.role, providerRefundId: refundResult.providerRefundId }
        : { merchantId: actor.merchantId, providerRefundId: refundResult.providerRefundId };

    const pending = await db.transaction(async (tx) =>
      createPendingRefund(tx, {
        transactionId: txRow.transactionId,
        provider: txRow.provider,
        idempotencyKey,
        amountMicros: amountMicros.toString(),
        currencyCode: txRow.currencyCode,
        reason,
        metadataJson,
      }),
    );
    return { state: "pending", pendingId: pending.pendingId };
  }

  if (refundResult.state === "pending_webhook") {
    await db.transaction(async (tx) => {
      await tx
        .update(paymentTransactions)
        .set({ status: "refund_pending_webhook", updatedAt: new Date() })
        .where(eq(paymentTransactions.transactionId, txRow.transactionId));
    });
    const providerCode = refundResult.error?.providerCode;
    return {
      state: "pending_webhook" as const,
      transactionId: txRow.transactionId,
      ...(providerCode !== undefined ? { providerCode } : {}),
    };
  }

  // 5. state === 'completed' — write ledger entry + applyDelta atomically
  const actorMeta =
    actor.kind === "admin"
      ? { source: "admin_refund", adminUserId: actor.adminUserId, adminRole: actor.role }
      : { source: "merchant_refund", merchantId: actor.merchantId };

  const ledgerWrite = await db.transaction(async (tx) => {
    // Re-lock the row for concurrent refund safety
    await tx
      .select({ id: paymentTransactions.transactionId })
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, txRow.transactionId))
      .for("update")
      .limit(1);

    const sourceId = txRow.providerRef ?? `tx:${txRow.transactionId}`;
    const { row: entry, inserted } = await appendLedgerEntryIdempotent(tx, {
      tenantId: txRow.tenantId,
      ownerId: txRow.ownerId,
      entryType: "refund",
      amountMicros: (-amountMicros).toString(),
      currencyCode: txRow.currencyCode,
      provider: txRow.provider,
      sourceId,
      metadataJson: {
        ...actorMeta,
        provider: txRow.provider,
        originalTransactionId: txRow.transactionId,
        reason,
        idempotencyKey,
        providerRefundId: refundResult.providerRefundId,
      },
    });

    if (inserted) {
      await applyDelta(tx, txRow.tenantId, txRow.currencyCode, -amountMicros);

      // If full refund, mark tx status='refunded'
      const newCumulative = -cumulativeRefundedMicros + amountMicros;
      if (newCumulative >= originalMicros) {
        await tx
          .update(paymentTransactions)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(eq(paymentTransactions.transactionId, txRow.transactionId));
      }
    }
    return { entry, inserted };
  });

  return {
    state: "completed" as const,
    entryId: ledgerWrite.entry.entryId,
    ...(refundResult.providerRefundId !== undefined ? { providerRefundId: refundResult.providerRefundId } : {}),
    inserted: ledgerWrite.inserted,
  };
}
