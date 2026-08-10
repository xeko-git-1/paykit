/**
 * Applies an inbound refund event to the ledger, the refund row, and the payment.
 *
 * Three defects lived in the inline version of this, and all three lost money or
 * misreported it:
 *
 *   - The ledger row was keyed on the PAYMENT reference. The ledger is unique on
 *     (provider, source_id, entry_type), so the second partial refund of one
 *     payment collided with the first, the insert reported "already present", and
 *     the balance move was therefore skipped. The money stayed in the wallet while
 *     the caller saw success. Keying on the refund's own identity fixes it.
 *   - The payment was set to `refunded` unconditionally, so a $1 refund of a $100
 *     payment read as fully refunded — and the refund gate then refused the
 *     remaining $99, because it will not refund an already-refunded payment.
 *   - No status guard, so a refund could be applied to a payment that was never
 *     credited, debiting a wallet for money it never received.
 */
import { isRefundableStatus, parseMicros, refundedPaymentStatus } from "@xeko-git-1/paykit";
import type { NormalizedWebhookEvent } from "@xeko-git-1/paykit";
import type { DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { applyDelta } from "@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js";
import {
  appendLedgerEntryIdempotent,
  sumRefundsByOriginalTransaction,
} from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js";
import {
  findActiveByTransaction,
  markCompleted,
} from "@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js";
import {
  createRefund,
  findByProviderRefundId,
  markSucceeded,
} from "@xeko-git-1/paykit-auth-core/db/repos/refund.repo.js";
import type { PaymentTransaction } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";

export interface RefundEventLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface ApplyRefundEventDeps {
  readonly provider: string;
  readonly logger?: RefundEventLogger;
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
}

/** What the handler did, so the router can decide whether to emit an event. */
export type RefundEventOutcome =
  | { readonly applied: false; readonly reason: string }
  | {
      readonly applied: true;
      readonly transactionId: string;
      readonly refundId: string;
      readonly status: "refunded" | "partially_refunded";
    };

/**
 * The identity this refund is keyed on, for both the refund row and the ledger.
 *
 * A provider that names its refunds gives a stable per-refund id, and two partial
 * refunds therefore get two ledger rows. A provider that does NOT name them leaves
 * nothing to tell a second refund apart from a redelivery of the first, so the
 * payment reference is used and the payment is limited to one refund — losing a
 * legitimate second refund is recoverable by hand, double-debiting a customer's
 * wallet from a duplicate webhook is not.
 */
function refundIdentity(evt: NormalizedWebhookEvent): {
  readonly key: string;
  readonly named: boolean;
} {
  if (evt.providerRefundId !== undefined && evt.providerRefundId.length > 0) {
    return { key: `refund:${evt.providerRefundId}`, named: true };
  }
  return { key: `refund:ref:${evt.providerRef}`, named: false };
}

/**
 * Apply a `payment.refunded` event inside the caller's transaction.
 *
 * Everything here is one transaction by necessity: the ledger row, the refund
 * row's status, and the payment's status have to agree, and a crash between them
 * would leave a refund that moved money without recording it (or the reverse).
 */
export async function applyRefundEvent(
  tx: DbOrTx,
  row: PaymentTransaction,
  evt: NormalizedWebhookEvent,
  deps: ApplyRefundEventDeps,
): Promise<RefundEventOutcome> {
  if (evt.refundAmountMicros === undefined || evt.currencyCode === undefined) {
    return { applied: false, reason: "event_missing_amount_or_currency" };
  }

  // A refund debits the wallet the payment credited. The wallet is keyed
  // (tenant_id, currency_code), so a mismatched currency would debit a DIFFERENT
  // wallet — reading as an unrefunded payment plus a negative balance in a
  // currency the customer never used.
  if (evt.currencyCode !== row.currencyCode) {
    deps.logger?.warn("refund currency does not match the payment — ignoring", {
      provider: deps.provider,
      providerRef: evt.providerRef,
      paymentCurrency: row.currencyCode,
      eventCurrency: evt.currencyCode,
    });
    deps.emitMetric?.("paykit_refund_currency_mismatch_total", { provider: deps.provider });
    return { applied: false, reason: "currency_mismatch" };
  }

  // Only a payment that actually holds money can give it back. Without this, a
  // refund event for a `pending` payment (never credited) or a `quarantine` one
  // (deliberately withheld) would debit the wallet for money it never received.
  if (!isRefundableStatus(row.status)) {
    deps.logger?.warn("refund event for a payment that is not refundable — ignoring", {
      provider: deps.provider,
      providerRef: evt.providerRef,
      paymentStatus: row.status,
    });
    deps.emitMetric?.("paykit_refund_not_refundable_total", { provider: deps.provider });
    return { applied: false, reason: `payment_status_${row.status}` };
  }

  let refundMicros: bigint;
  try {
    refundMicros = parseMicros(evt.refundAmountMicros);
  } catch {
    deps.logger?.warn("refund event carried an unreadable amount — ignoring", {
      provider: deps.provider,
      providerRef: evt.providerRef,
    });
    return { applied: false, reason: "unreadable_amount" };
  }
  if (refundMicros <= 0n) {
    return { applied: false, reason: "non_positive_amount" };
  }

  const identity = refundIdentity(evt);

  // A refund this provider already named and paykit already recorded as succeeded
  // is a redelivery. Returning early keeps the ledger and the balance untouched;
  // the ledger's unique index would also catch it, but relying on that alone
  // leaves the refund row and payment status to be re-derived needlessly.
  if (identity.named && evt.providerRefundId !== undefined) {
    const existing = await findByProviderRefundId(tx, {
      provider: deps.provider,
      providerRefundId: evt.providerRefundId,
    });
    if (existing !== undefined && existing.status === "succeeded") {
      return { applied: false, reason: "already_succeeded" };
    }
  }

  // The refund row comes first: it is the identity the ledger entry is keyed on,
  // and `(provider, idempotency_key)` is what makes a redelivery reuse the same
  // row instead of creating a second refund.
  const { row: refundRow } = await createRefund(tx, {
    transactionId: row.transactionId,
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    provider: deps.provider,
    idempotencyKey: identity.key,
    amountMicros: refundMicros.toString(),
    currencyCode: row.currencyCode,
    reason: "provider_webhook",
    ...(evt.providerRefundId !== undefined ? { providerRefundId: evt.providerRefundId } : {}),
    metadataJson: {
      source: "refund_webhook",
      provider: deps.provider,
      originalTransactionId: row.transactionId,
      ...evt.metadata,
    },
  });

  if (refundRow.status === "succeeded") {
    // Recorded under this key already, by an earlier delivery or the admin path.
    return { applied: false, reason: "already_succeeded" };
  }

  const { row: entry, inserted } = await appendLedgerEntryIdempotent(tx, {
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    entryType: "refund",
    // Refunds are stored negative: the sign carries the direction, and the refund
    // row's own amount stays positive.
    amountMicros: (-refundMicros).toString(),
    currencyCode: row.currencyCode,
    provider: deps.provider,
    // The refund's identity, NOT the payment's. This is the fix for the collision
    // that silently dropped every partial refund after the first.
    sourceId: identity.key,
    metadataJson: {
      source: "refund",
      provider: deps.provider,
      originalTransactionId: row.transactionId,
      refundId: refundRow.refundId,
      ...evt.metadata,
    },
  });

  // The balance moves only for a new ledger row. The unique index is what makes a
  // redelivered refund a no-op rather than a second debit.
  if (inserted) {
    await applyDelta(tx, row.tenantId, row.currencyCode, -refundMicros);
  }

  // Bind the refund to the row that moved the money. Guarded on the refund still
  // being open, so two concurrent deliveries produce one winner.
  const settled = await markSucceeded(tx, {
    refundId: refundRow.refundId,
    ledgerEntryId: entry.entryId,
    ...(evt.providerRefundId !== undefined ? { providerRefundId: evt.providerRefundId } : {}),
  });
  if (settled === undefined) {
    // Someone else settled it between the read and here. The money moved exactly
    // once either way — whoever won owns the payment status update.
    return { applied: false, reason: "settled_concurrently" };
  }

  // Release reservations this transaction was holding. A committed refund and a
  // still-open reservation for the same money would both count against the
  // refundable remainder, understating what is left.
  const activeReservations = await findActiveByTransaction(tx, {
    provider: deps.provider,
    transactionId: row.transactionId,
  });
  for (const reservation of activeReservations) {
    await markCompleted(tx, reservation.pendingId);
  }

  // Derive the payment's status from what has actually been refunded. Both paths
  // that write refund ledger entries (webhook here, admin in refund-core) use the
  // same ledger sum, so the total is complete regardless of which path was used.
  const totalRefundedStr = await sumRefundsByOriginalTransaction(tx, {
    tenantId: row.tenantId,
    currencyCode: row.currencyCode,
    originalTransactionId: row.transactionId,
  });
  // Ledger refund entries are stored negative; negate to get the positive total.
  const refundedTotal = -parseMicros(totalRefundedStr);
  const nextStatus = refundedPaymentStatus(parseMicros(row.amountMicros), refundedTotal);
  if (nextStatus === "completed") {
    // Unreachable in practice: a refund just succeeded, so the total is positive.
    return { applied: false, reason: "no_succeeded_refunds" };
  }

  const updated = await updateTransactionStatus(tx, row.transactionId, nextStatus);
  if (updated === undefined) {
    return { applied: false, reason: "payment_status_update_missed" };
  }

  deps.emitMetric?.(
    nextStatus === "refunded" ? "paykit_refund_completed_total" : "paykit_refund_partial_total",
    { provider: deps.provider },
  );

  return {
    applied: true,
    transactionId: updated.transactionId,
    refundId: refundRow.refundId,
    status: nextStatus,
  };
}
