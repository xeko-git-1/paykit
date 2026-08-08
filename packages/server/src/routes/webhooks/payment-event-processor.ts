/**
 * Applying a normalized webhook event to a payment.
 *
 * This is the business half of the webhook pipeline, separated from the transport
 * half for one concrete reason: a delivery that could not be processed when it
 * arrived is retried later by a worker, and the retry must apply *exactly* the
 * same rules. Two copies of this switch — one on the request path, one in the
 * worker — would drift, and the drift would show up as money moving differently
 * depending on which attempt happened to succeed.
 *
 * Everything here runs inside the caller's transaction, on a payment row the
 * caller has already locked FOR UPDATE. Nothing here performs an outbound call:
 * compliance screening is enqueued, never awaited, because a third-party latency
 * spike must not be held across a row lock and a pooled connection.
 */
import type { NormalizedWebhookEvent } from "@vibecc/paykit";
import { microsStringToBigInt } from "@vibecc/paykit";
import type { DbClient } from "@vibecc/paykit-auth-core/db/client.js";
import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import {
  commitReservation,
  releaseReservation,
} from "@vibecc/paykit-auth-core/db/repos/discount.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { enqueueScreeningJob } from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
import type { PaymentTransaction } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import {
  AWAITING_PAYMENT_STATUSES,
  paymentTransactions,
} from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import { and, eq, inArray } from "drizzle-orm";
import { applyRefundEvent } from "./refund-event-handler.js";
import { evaluateSettlementAmount } from "./settlement-amount-guard.js";

export interface PaymentEventContext {
  readonly provider: string;
  /** False only for payer-controlled rails (bank transfer) — see the guard. */
  readonly settlesExactAmount: boolean;
  /** True when a screening service is configured, so credits are deferred. */
  readonly screeningConfigured: boolean;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
}

export interface PaymentEventOutcome {
  /** Set when a lifecycle event should be emitted after the commit. */
  readonly emitFor: NormalizedWebhookEvent["type"] | null;
  readonly transactionId: string | null;
  /** True when the payment was parked and a screening job enqueued. */
  readonly screeningEnqueued: boolean;
}

const NO_OUTCOME: PaymentEventOutcome = {
  emitFor: null,
  transactionId: null,
  screeningEnqueued: false,
};

function emitted(type: NormalizedWebhookEvent["type"], transactionId: string): PaymentEventOutcome {
  return { emitFor: type, transactionId, screeningEnqueued: false };
}

/**
 * Apply one event to one locked payment row.
 *
 * A returned outcome with `emitFor: null` is a deliberate no-op — a duplicate, a
 * payment already past this state, an underpayment that must not credit. The
 * caller still treats the delivery as processed: nothing was owed, and leaving it
 * retryable would mean retrying forever.
 */
export async function applyPaymentEvent(
  tx: DbClient,
  row: PaymentTransaction,
  evt: NormalizedWebhookEvent,
  ctx: PaymentEventContext,
): Promise<PaymentEventOutcome> {
  switch (evt.type) {
    case "payment.completed":
      return applyCompleted(tx, row, evt, ctx);
    case "payment.refunded": {
      // Delegated because a refund is no longer one ledger write: it has its own
      // row and identity, the payment's status is derived from the refunded total
      // rather than assumed to be full, and both have to agree with the ledger in
      // this same transaction.
      const outcome = await applyRefundEvent(tx, row, evt, {
        provider: ctx.provider,
        ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
        ...(ctx.emitMetric !== undefined ? { emitMetric: ctx.emitMetric } : {}),
      });
      return outcome.applied ? emitted("payment.refunded", outcome.transactionId) : NO_OUTCOME;
    }
    case "payment.expired":
      return applyTerminal(tx, row, "expired", "payment.expired");
    case "payment.failed":
      return applyTerminal(tx, row, "failed", "payment.failed");
    case "payment.underpaid": {
      // Audit trail only, no ledger move: the customer paid less than the charge,
      // and an admin reconciles via the ledger adjust route. Status stays as it
      // was so the row still reads as awaiting payment.
      ctx.logger?.warn("payment.underpaid received — no ledger move", {
        provider: ctx.provider,
        providerRef: evt.providerRef,
        actualAmountMicros: evt.amountMicros,
        expectedAmountMicros: evt.expectedAmountMicros,
      });
      ctx.emitMetric?.("paykit_underpaid_received_total", { provider: ctx.provider });
      return emitted("payment.underpaid", row.transactionId);
    }
    case "payment.amount_mismatch": {
      // Webhook amount drifted beyond tolerance. Quarantine rather than credit a
      // number neither side agrees on; an admin reconciles.
      ctx.logger?.warn("payment.amount_mismatch — quarantining", {
        provider: ctx.provider,
        providerRef: evt.providerRef,
        actualAmountMicros: evt.amountMicros,
        expectedAmountMicros: evt.expectedAmountMicros,
      });
      const updated = await updateTransactionStatus(tx, row.transactionId, "quarantine");
      ctx.emitMetric?.("paykit_amount_mismatch_total", { provider: ctx.provider });
      // Quarantine is terminal for this payment — free any discount reservation.
      await releaseDiscountReservation(tx, row.metadataJson);
      return updated !== undefined
        ? emitted("payment.amount_mismatch", updated.transactionId)
        : NO_OUTCOME;
    }
    default:
      // 'unknown' — recorded, no DB writes.
      return NO_OUTCOME;
  }
}

/** Statuses from which a payment may still be completed by a webhook. */
function isAwaitingPayment(status: string): boolean {
  return (AWAITING_PAYMENT_STATUSES as readonly string[]).includes(status);
}

async function applyCompleted(
  tx: DbClient,
  row: PaymentTransaction,
  evt: NormalizedWebhookEvent,
  ctx: PaymentEventContext,
): Promise<PaymentEventOutcome> {
  if (!isAwaitingPayment(row.status)) return NO_OUTCOME;
  if (evt.amountMicros === undefined || evt.currencyCode === undefined) return NO_OUTCOME;

  // Payer-controlled-amount rails (bank transfer): a memo match proves intent,
  // not amount, so compare requested vs received before crediting. Exact-settling
  // rails short-circuit and keep their verified path.
  const settlement = evaluateSettlementAmount({
    settlesExactAmount: ctx.settlesExactAmount,
    requestedMicros: row.amountMicros,
    receivedMicros: evt.amountMicros,
  });

  if (settlement.decision === "underpaid") {
    // Short transfer: no ledger move, status unchanged so the admin can reconcile
    // (or the payer can top up). Emitting no event keeps `completed` meaning
    // paid-in-full for every downstream consumer.
    ctx.logger?.warn("payment underpaid — received < requested; not crediting", {
      provider: ctx.provider,
      providerRef: evt.providerRef,
      requestedMicros: settlement.requestedMicros,
      receivedMicros: settlement.receivedMicros,
      shortfallMicros: settlement.shortfallMicros,
    });
    ctx.emitMetric?.("paykit_underpaid_received_total", { provider: ctx.provider });
    return NO_OUTCOME;
  }

  if (settlement.decision === "unreadable_amount") {
    // Neither amount can be trusted, so crediting would be guesswork. Quarantine
    // rather than leaving it awaiting payment: a malformed amount is a defect, not
    // a payer action to wait on.
    ctx.logger?.warn("payment amount unreadable — quarantining without credit", {
      provider: ctx.provider,
      providerRef: evt.providerRef,
      unreadable: settlement.reason,
    });
    await updateTransactionStatus(tx, row.transactionId, "quarantine");
    ctx.emitMetric?.("paykit_amount_unreadable_total", { provider: ctx.provider });
    await releaseDiscountReservation(tx, row.metadataJson);
    return NO_OUTCOME;
  }

  if (settlement.decision === "overpaid") {
    // Credit what was requested and leave the overage for manual reconciliation —
    // the happy path must not block on generosity.
    ctx.logger?.warn("payment overpaid — crediting requested amount only", {
      provider: ctx.provider,
      providerRef: evt.providerRef,
      requestedMicros: settlement.requestedMicros,
      receivedMicros: settlement.receivedMicros,
      overageMicros: settlement.overageMicros,
    });
    ctx.emitMetric?.("paykit_overpaid_total", { provider: ctx.provider });
  }
  const creditMicros = settlement.creditMicros;

  // The webhook's currency must match the currency the payment was priced in.
  // Wallets are keyed (tenant_id, currency_code), so an event claiming a different
  // currency does not fail on its own — it credits a DIFFERENT wallet, which reads
  // downstream as the customer never having paid while a phantom balance appears
  // in a currency they never used.
  if (evt.currencyCode !== row.currencyCode) {
    ctx.logger?.warn("webhook currency does not match transaction — quarantining", {
      provider: ctx.provider,
      providerRef: evt.providerRef,
      transactionCurrency: row.currencyCode,
      eventCurrency: evt.currencyCode,
    });
    await updateTransactionStatus(tx, row.transactionId, "quarantine");
    ctx.emitMetric?.("paykit_currency_mismatch_total", { provider: ctx.provider });
    // Terminal for this payment — free any discount reservation.
    await releaseDiscountReservation(tx, row.metadataJson);
    return NO_OUTCOME;
  }

  // Compliance screening is an outbound call to a tenant-supplied service. It must
  // not run here: this transaction holds a FOR UPDATE lock on the payment row plus
  // a pooled connection, and a slow screening provider would hold both for its
  // entire latency while every redelivery of this webhook queues behind the lock.
  //
  // Instead the payment is parked in a durable state and a job is enqueued; the
  // verdict is applied by the screening runner in a separate transaction. The park
  // is what makes this crash-safe — a process death before the verdict leaves a
  // claimable job, not a lost payment.
  if (ctx.screeningConfigured) {
    await parkForScreening(tx, row.transactionId);
    await enqueueScreeningJob(tx, {
      transactionId: row.transactionId,
      tenantId: row.tenantId,
      ownerId: row.ownerId,
      provider: ctx.provider,
      // Same ledger idempotency key the inline credit would have used, so the
      // deferred credit still collapses with a provider resend.
      sourceId: evt.providerRef,
      creditMicros,
      currencyCode: row.currencyCode,
      eventJson: { ...evt },
    });
    ctx.emitMetric?.("paykit_screening_pending_total", { provider: ctx.provider });
    // The discount reservation stays held: the payment is not resolved yet, and the
    // verdict path commits or releases it.
    return { emitFor: null, transactionId: row.transactionId, screeningEnqueued: true };
  }

  // UNIQUE (provider, source_id, entry_type) blocks a resend double-credit when a
  // provider rotates event_id but reuses the session/charge id.
  const { inserted } = await appendLedgerEntryIdempotent(tx, {
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    entryType: "credit",
    amountMicros: creditMicros,
    currencyCode: evt.currencyCode,
    provider: ctx.provider,
    sourceId: evt.providerRef,
    metadataJson: {
      source: "payment",
      provider: ctx.provider,
      transactionId: row.transactionId,
      ...evt.metadata,
    },
  });
  if (inserted) {
    await applyDelta(tx, row.tenantId, evt.currencyCode, microsStringToBigInt(creditMicros));
  }
  const updated = await updateTransactionStatus(tx, row.transactionId, "completed");

  // Persist the provider-side payment id when it differs from provider_ref
  // (NowPayments: refund keys on the numeric payment_id, which only arrives in this
  // IPN — provider_ref holds order_id for the lookup).
  if (evt.providerPaymentId !== undefined) {
    await tx
      .update(paymentTransactions)
      .set({ providerPaymentId: evt.providerPaymentId, updatedAt: new Date() })
      .where(eq(paymentTransactions.transactionId, row.transactionId));
  }

  // Commit a discount reservation now that the payment is final. Guarded by
  // reserved > 0 in the repo so a resent webhook cannot double-count.
  await commitDiscountReservation(tx, row.metadataJson);

  return updated !== undefined ? emitted("payment.completed", updated.transactionId) : NO_OUTCOME;
}

/**
 * A payment that will never complete: expired or failed. Both free the discount
 * reservation, because nothing is going to claim it.
 */
async function applyTerminal(
  tx: DbClient,
  row: PaymentTransaction,
  status: "expired" | "failed",
  emitType: NormalizedWebhookEvent["type"],
): Promise<PaymentEventOutcome> {
  if (!isAwaitingPayment(row.status)) return NO_OUTCOME;
  const updated = await updateTransactionStatus(tx, row.transactionId, status);
  await releaseDiscountReservation(tx, row.metadataJson);
  return updated !== undefined ? emitted(emitType, updated.transactionId) : NO_OUTCOME;
}

/**
 * Park a payment in `screening_pending`, guarded on it still awaiting payment.
 *
 * The guard makes the park itself the exactly-once gate: two concurrent deliveries
 * of the same completion event cannot both park (and therefore both enqueue), and
 * a payment some other path already moved on from is left alone. Written here
 * rather than through the status repo because that helper is shared with paths
 * which must not be able to reach this state.
 */
async function parkForScreening(
  tx: DbClient,
  transactionId: string,
): Promise<{ transactionId: string } | undefined> {
  const [parked] = await tx
    .update(paymentTransactions)
    .set({ status: "screening_pending", updatedAt: new Date() })
    .where(
      and(
        eq(paymentTransactions.transactionId, transactionId),
        // Both spellings of "awaiting payment": historical rows hold `pending`,
        // new checkouts hold `awaiting_payment`.
        inArray(paymentTransactions.status, [...AWAITING_PAYMENT_STATUSES]),
      ),
    )
    .returning({ transactionId: paymentTransactions.transactionId });
  return parked;
}

// ---------------------------------------------------------------------------
// Discount reservation lifecycle — metadataJson.discountId is set only by the
// service v1 checkout when a promo code was reserved. These extract it and move
// the reservation to its terminal state inside the caller's transaction.
// ---------------------------------------------------------------------------

function discountIdFrom(metadataJson: unknown): string | null {
  if (typeof metadataJson !== "object" || metadataJson === null) return null;
  const id = (metadataJson as Record<string, unknown>).discountId;
  return typeof id === "string" ? id : null;
}

async function commitDiscountReservation(tx: DbClient, metadataJson: unknown): Promise<void> {
  const discountId = discountIdFrom(metadataJson);
  if (discountId !== null) await commitReservation(tx, discountId);
}

async function releaseDiscountReservation(tx: DbClient, metadataJson: unknown): Promise<void> {
  const discountId = discountIdFrom(metadataJson);
  if (discountId !== null) await releaseReservation(tx, discountId);
}
