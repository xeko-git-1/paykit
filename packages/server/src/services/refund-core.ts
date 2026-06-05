/**
 * Guard-agnostic refund core — shared business logic for both admin and
 * merchant (API-key) refund paths.
 *
 * Uses a RESERVE-THEN-RECONCILE pattern:
 *   tx1 (FOR UPDATE lock):
 *     1. Dedup: if reservation or ledger entry exists for this key → return existing result
 *     2. Compute remaining = original + committed_refunds + active_reservations
 *     3. If amount > remaining → reject (PSP never called)
 *     4. Insert reservation (pending_refund in 'queued' state)
 *   (lock released on commit)
 *
 *   adapter.refund() — outside the lock (no lock held across PSP I/O)
 *
 *   tx2 (finalize):
 *     - completed → ledger entry + applyDelta + markCompleted + maybe set tx.status='refunded'
 *     - pending   → keep reservation (reconciler finalizes later)
 *     - pending_webhook → set tx.status, keep reservation
 *     - failed/unsupported → markFailed (releases reserved headroom)
 *
 * This ensures:
 *   - Concurrent refunds cannot over-refund (reservation counts toward remaining)
 *   - PSP is never called for an amount that exceeds remaining
 *   - Retries (same idempotency key) return existing result without re-evaluating gate
 */
import type { ProviderRegistry, RefundResult } from "@vibecc/paykit";
import { eq } from "drizzle-orm";
import type { DbClient } from "@vibecc/paykit-auth-core/db/client.js";
import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import {
  appendLedgerEntryIdempotent,
  findLedgerEntryBySourceId,
  sumRefundsByOriginalTransaction,
} from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import {
  createPendingRefund,
  findByProviderAndKey,
  markCompleted,
  markFailed,
  sumActiveReservationsByTransaction,
} from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import { paymentTransactions } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import type { PaymentTransaction } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";

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
// Internal result types for the reservation phase
// ---------------------------------------------------------------------------

type ReserveSuccess = { kind: "reserved"; pendingId: string };
type ReserveDedup = { kind: "dedup_completed"; entryId: string }
  | { kind: "dedup_pending"; pendingId: string }
  | { kind: "dedup_failed"; pendingId: string };
type ReserveRejected = { kind: "exceeds_remaining"; remaining: bigint };
type ReserveOutcome = ReserveSuccess | ReserveDedup | ReserveRejected;

// ---------------------------------------------------------------------------
// Core refund logic — reserve-then-reconcile
// ---------------------------------------------------------------------------

export async function executeRefund(
  deps: RefundCoreDeps,
  actor: RefundActor,
  input: RefundCoreInput,
): Promise<RefundCoreResult> {
  const { db, registry, logger } = deps;
  const { txRow, amountMicros, idempotencyKey, reason } = input;

  const originalMicros = BigInt(txRow.amountMicros.split(".")[0] ?? "0");

  // Fail fast if provider unknown
  const adapter = registry.get(txRow.provider);
  if (!adapter) {
    return { state: "provider_unknown", provider: txRow.provider };
  }

  // Defense-in-depth: a fully-refunded transaction must not accept further refunds.
  // Guards the over-refund window if a reservation is ever released without a
  // corresponding committed ledger entry (e.g. race between webhook + reconciler).
  if (txRow.status === "refunded") {
    return { state: "exceeds_remaining", remaining: 0n, requested: amountMicros };
  }

  // ─── TX1: Reserve under lock ───────────────────────────────────────────────
  const reserveOutcome = await db.transaction(async (tx) => {
    // Lock the transaction row to serialize concurrent refund attempts
    await tx
      .select({ id: paymentTransactions.transactionId })
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, txRow.transactionId))
      .for("update")
      .limit(1);

    // DEDUP FIRST: a retry must return the existing result without re-evaluating
    // the remaining gate. Otherwise a full-refund retry sees remaining=0 and rejects.
    const existingReservation = await findByProviderAndKey(tx, {
      provider: txRow.provider,
      idempotencyKey,
    });

    if (existingReservation) {
      if (existingReservation.state === "completed") {
        // Reservation finalized — look up the ledger entry for the entryId
        const sourceId = `tx:${txRow.transactionId}:${idempotencyKey}`;
        const ledgerEntry = await findLedgerEntryBySourceId(tx, {
          provider: txRow.provider,
          sourceId,
          entryType: "refund",
        });
        const entryId = ledgerEntry?.entryId ?? existingReservation.pendingId;
        return { kind: "dedup_completed", entryId } as ReserveOutcome;
      }
      if (existingReservation.state === "failed" || existingReservation.state === "timed_out") {
        return { kind: "dedup_failed", pendingId: existingReservation.pendingId } as ReserveOutcome;
      }
      // queued or processing — still in-flight
      return { kind: "dedup_pending", pendingId: existingReservation.pendingId } as ReserveOutcome;
    }

    // Also check ledger directly — covers edge case where reservation was cleaned
    // up but ledger entry persists (e.g. legacy refunds before reserve-then-reconcile)
    const sourceId = `tx:${txRow.transactionId}:${idempotencyKey}`;
    const existingLedger = await findLedgerEntryBySourceId(tx, {
      provider: txRow.provider,
      sourceId,
      entryType: "refund",
    });
    if (existingLedger) {
      return { kind: "dedup_completed", entryId: existingLedger.entryId } as ReserveOutcome;
    }

    // Compute authoritative remaining under the lock:
    // remaining = original + Σ(committed refund entries) + Σ(active reservations)
    // committed refunds are negative, so addition reduces remaining
    const committedSumStr = await sumRefundsByOriginalTransaction(tx, {
      tenantId: txRow.tenantId,
      currencyCode: txRow.currencyCode,
      originalTransactionId: txRow.transactionId,
    });
    const committedMicros = BigInt(committedSumStr.split(".")[0] ?? "0"); // negative

    // Active reservations represent money already "claimed" but not yet in ledger
    const reservedSumStr = await sumActiveReservationsByTransaction(tx, {
      transactionId: txRow.transactionId,
      currencyCode: txRow.currencyCode,
    });
    const reservedMicros = BigInt(reservedSumStr.split(".")[0] ?? "0"); // positive

    // remaining = original - |committed| - reserved
    const remaining = originalMicros + committedMicros - reservedMicros;

    if (amountMicros > remaining) {
      return { kind: "exceeds_remaining", remaining } as ReserveOutcome;
    }

    // Insert reservation — counts toward remaining for any concurrent refund
    const actorMeta =
      actor.kind === "admin"
        ? { adminUserId: actor.adminUserId, adminRole: actor.role }
        : { merchantId: actor.merchantId };

    const reservation = await createPendingRefund(tx, {
      transactionId: txRow.transactionId,
      provider: txRow.provider,
      idempotencyKey,
      amountMicros: amountMicros.toString(),
      currencyCode: txRow.currencyCode,
      reason,
      metadataJson: { ...actorMeta, originalTransactionId: txRow.transactionId },
    });

    return { kind: "reserved", pendingId: reservation.pendingId } as ReserveOutcome;
  });

  // ─── Handle dedup / rejection from tx1 ─────────────────────────────────────
  if (reserveOutcome.kind === "dedup_completed") {
    return { state: "completed", entryId: reserveOutcome.entryId, inserted: false };
  }
  if (reserveOutcome.kind === "dedup_pending") {
    return { state: "pending", pendingId: reserveOutcome.pendingId };
  }
  if (reserveOutcome.kind === "dedup_failed") {
    return { state: "failed", statusCode: 502, code: "PROVIDER_REFUND_FAILED", message: "Prior refund attempt failed" };
  }
  if (reserveOutcome.kind === "exceeds_remaining") {
    return { state: "exceeds_remaining", remaining: reserveOutcome.remaining, requested: amountMicros };
  }

  // ─── PSP call — outside the lock ──────────────────────────────────────────
  const pendingId = reserveOutcome.pendingId;
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
    // Release reservation headroom so subsequent refunds can use this capacity
    await db.transaction(async (tx) => {
      await markFailed(tx, pendingId, { error: err instanceof Error ? err.message : String(err) });
    });
    return { state: "failed", statusCode: 502, code: "PROVIDER_REFUND_ERROR", message: "Provider refund call failed" };
  }

  // ─── TX2: Finalize based on PSP result ─────────────────────────────────────
  return finalizeRefund(deps, actor, input, pendingId, refundResult, originalMicros);
}

// ---------------------------------------------------------------------------
// Finalize — writes ledger entry + balance delta on completion, or releases
// reservation on failure. Separated for clarity and testability.
// ---------------------------------------------------------------------------

async function finalizeRefund(
  deps: RefundCoreDeps,
  actor: RefundActor,
  input: RefundCoreInput,
  pendingId: string,
  refundResult: RefundResult,
  originalMicros: bigint,
): Promise<RefundCoreResult> {
  const { db } = deps;
  const { txRow, amountMicros, idempotencyKey, reason } = input;

  if (refundResult.state === "unsupported") {
    // Release reservation — provider doesn't support refund
    await db.transaction(async (tx) => {
      await markFailed(tx, pendingId, { reason: "provider_unsupported" });
    });
    return {
      state: "unsupported",
      statusCode: 501,
      code: "PROVIDER_REFUND_UNSUPPORTED",
      message: refundResult.error?.message ?? "Provider does not support refund via API",
    };
  }

  if (refundResult.state === "failed") {
    // Release reservation — provider rejected the refund
    await db.transaction(async (tx) => {
      await markFailed(tx, pendingId, {
        reason: "provider_rejected",
        providerMessage: refundResult.error?.message,
      });
    });
    return {
      state: "failed",
      statusCode: 502,
      code: "PROVIDER_REFUND_FAILED",
      message: refundResult.error?.message ?? "Provider rejected refund",
    };
  }

  if (refundResult.state === "pending") {
    // Keep reservation active — reconciler will finalize when provider confirms
    return { state: "pending", pendingId };
  }

  if (refundResult.state === "pending_webhook") {
    // Keep reservation active, update tx status to signal webhook expected
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

  // ─── state === 'completed' — write ledger + balance + mark reservation done ─
  const actorMeta =
    actor.kind === "admin"
      ? { source: "admin_refund", adminUserId: actor.adminUserId, adminRole: actor.role }
      : { source: "merchant_refund", merchantId: actor.merchantId };

  const sourceId = `tx:${txRow.transactionId}:${idempotencyKey}`;

  const ledgerWrite = await db.transaction(async (tx) => {
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

      // Check if cumulative refunds now cover the full original amount
      const totalRefundedStr = await sumRefundsByOriginalTransaction(tx, {
        tenantId: txRow.tenantId,
        currencyCode: txRow.currencyCode,
        originalTransactionId: txRow.transactionId,
      });
      const totalRefunded = BigInt(totalRefundedStr.split(".")[0] ?? "0"); // negative
      // totalRefunded is negative; if |totalRefunded| >= original, tx is fully refunded
      if (-totalRefunded >= originalMicros) {
        await tx
          .update(paymentTransactions)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(eq(paymentTransactions.transactionId, txRow.transactionId));
      }
    }

    // Mark reservation completed — no longer counts toward active headroom
    await markCompleted(tx, pendingId);

    return { entry, inserted };
  });

  return {
    state: "completed" as const,
    entryId: ledgerWrite.entry.entryId,
    ...(refundResult.providerRefundId !== undefined ? { providerRefundId: refundResult.providerRefundId } : {}),
    inserted: ledgerWrite.inserted,
  };
}
