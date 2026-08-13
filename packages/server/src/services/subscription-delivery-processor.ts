/**
 * Processing one recorded SUBSCRIPTION webhook delivery.
 *
 * The payment pipeline splits a webhook into record-then-process (see
 * webhook-delivery-processor.ts); this is the subscription side of the same
 * split. Before it existed, the subscription handler did its business work in a
 * single transaction whose first statement was the dedup row, and the one
 * timing case that cannot be swallowed — an `invoice.paid` arriving before the
 * `sub.created` that would create its subscription row — was answered with a
 * 409 so the provider would redeliver. Durability rested entirely on the
 * provider's retry policy: if Stripe gave up before the subscription row
 * existed, the customer's payment was lost with nothing to replay from.
 *
 * Routing the delivery through the inbox makes that case retryable work paykit
 * owns: the payload is durable, `subscription_not_found` parks the row as
 * `unmatched`, and the drain retries it on the inbox backoff until the
 * subscription lands or the attempt cap pages a human.
 *
 * Business rules are unchanged from the previous handler:
 *   - sub.created/updated/deleted upsert the cache with last-write-wins
 *   - invoice.paid credits the ledger (USD only; zero, mismatched-currency and
 *     late-after-cancel invoices are recorded skips)
 *   - invoice.failed marks the subscription past_due
 *   - charge.refunded / dispute.funds_withdrawn / credit_note.created debit
 *   - charge.dispute.created is audit-only
 *   - customer.deleted cascade-cancels and clears the provider customer id
 *
 * As in the payment processor, `markSubscriptionDeliveryProcessed` runs inside
 * the business transaction, so "marked done" and "actually done" are one fact.
 */
import { nextAttemptAt } from "@xeko-git-1/paykit";
import type { NormalizedSubscriptionEvent, SubscriptionStatus } from "@xeko-git-1/paykit";
import type { DbClient, DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import * as customerRepo from "@xeko-git-1/paykit-auth-core/db/repos/customer.repo.js";
import { appendLedgerEntryIdempotent } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { appendSubscriptionEvent } from "@xeko-git-1/paykit-auth-core/db/repos/subscription-event.repo.js";
import * as subscriptionRepo from "@xeko-git-1/paykit-auth-core/db/repos/subscription.repo.js";
import {
  markDeliveryDeadLettered,
  markDeliveryFailed,
  markDeliveryUnmatched,
  markSubscriptionDeliveryProcessed,
} from "@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js";
import type { Subscription } from "@xeko-git-1/paykit-auth-core/db/schema/subscriptions.js";
import type { WebhookInboxRow } from "@xeko-git-1/paykit-auth-core/db/schema/webhook-inbox.js";
import {
  INBOX_BASE_RETRY_MS,
  INBOX_MAX_ATTEMPTS,
  INBOX_MAX_RETRY_MS,
} from "./webhook-inbox-policy.js";

const LEDGER_CURRENCY = "USD";

export interface SubscriptionDeliveryProcessorDeps {
  readonly db: DbClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  /** Called when an invoice is deliberately not credited (zero, non-USD, late). */
  readonly onLedgerSkipped?: (reason: string, payload: Record<string, unknown>) => void;
  /** Injectable so a test can assert the retry schedule instead of sleeping. */
  readonly random?: () => number;
  readonly now?: () => Date;
}

export type SubscriptionDeliveryResult =
  | {
      readonly kind: "processed";
      /** Null for legitimate no-ops (e.g. customer.deleted over zero rows). */
      readonly matchedSubscriptionId: string | null;
    }
  | { readonly kind: "unmatched" }
  | { readonly kind: "dead_letter"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Apply a claimed subscription delivery. The caller must already hold the claim:
 * the row is in `processing` and its lease has not expired.
 */
export async function processSubscriptionDelivery(
  deps: SubscriptionDeliveryProcessorDeps,
  row: WebhookInboxRow,
): Promise<SubscriptionDeliveryResult> {
  const now = deps.now?.() ?? new Date();
  const evt = subscriptionEventFrom(row);
  if (evt === undefined) {
    const reason = "stored normalized payload is not a usable subscription event";
    await markDeliveryDeadLettered(deps.db, {
      inboxId: row.inboxId,
      errorCode: "UNREADABLE_PAYLOAD",
      errorMessage: reason,
      now,
    });
    deps.emitMetric?.("paykit_webhook_dead_letter_total", { provider: row.provider });
    return { kind: "dead_letter", reason };
  }

  let matched: { subscriptionId: string; tenantId: string } | undefined;

  try {
    await deps.db.transaction(async (tx) => {
      matched = await applySubscriptionEvent(tx, deps, row.provider, evt);
      // Marked done in the same transaction as the work itself, so the two can
      // never disagree. A rollback below takes this with it and the delivery is
      // retried.
      await markSubscriptionDeliveryProcessed(tx, {
        inboxId: row.inboxId,
        ...(matched !== undefined
          ? { matchedSubscriptionId: matched.subscriptionId, tenantId: matched.tenantId }
          : {}),
        now,
      });
    });
  } catch (err) {
    if (err instanceof SubscriptionNotYetRecorded) {
      return recordUnmatched(deps, row, err, now);
    }
    return recordFailure(deps, row, err, now);
  }

  return { kind: "processed", matchedSubscriptionId: matched?.subscriptionId ?? null };
}

/**
 * Raised when an event cannot be applied YET, as opposed to not needing to be.
 *
 * Stripe can deliver an `invoice.paid` before the subscription event that creates
 * its subscription row. That is a timing fact, not a verdict: the delivery is
 * parked `unmatched` and retried by the drain, exactly like a payment webhook
 * that raced its checkout.
 */
class SubscriptionNotYetRecorded extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super("subscription event cannot be applied yet");
    this.name = "SubscriptionNotYetRecorded";
  }
}

/**
 * The business rules, in one transaction. Returns the subscription the event was
 * matched to, or undefined for events that legitimately touch none.
 */
async function applySubscriptionEvent(
  tx: DbOrTx,
  deps: SubscriptionDeliveryProcessorDeps,
  provider: string,
  evt: NormalizedSubscriptionEvent,
): Promise<{ subscriptionId: string; tenantId: string } | undefined> {
  if (evt.type === "customer.deleted") {
    await handleCustomerDeleted(tx, provider, evt);
    return undefined;
  }

  const existing = await subscriptionRepo.findByProviderSub(tx, provider, evt.subscriptionId);

  let touched: Subscription | undefined;
  if (evt.type === "sub.created" || evt.type === "sub.updated" || evt.type === "sub.deleted") {
    touched = await handleSubLifecycle(tx, deps, provider, evt, existing);
  } else if (evt.type === "invoice.paid") {
    await handleInvoicePaid(tx, deps, provider, evt, existing);
  } else if (evt.type === "invoice.failed") {
    await handleInvoiceFailed(tx, provider, evt, existing);
  } else if (
    evt.type === "charge.refunded" ||
    evt.type === "charge.dispute.created" ||
    evt.type === "charge.dispute.funds_withdrawn" ||
    evt.type === "credit_note.created"
  ) {
    await handleRefundOrDispute(tx, deps, provider, evt, existing);
  }

  // Audit rows are appended only for subscriptions that already existed before
  // this event — the pre-inbox handler behaved the same way, and changing the
  // audit surface is not part of the durability fix.
  if (existing) {
    await appendSubscriptionEvent(tx, {
      subscriptionId: existing.subscriptionId,
      provider,
      eventType: evt.type,
      rawPayload: { ...evt.metadata, eventId: evt.eventId },
    });
  }

  const match = existing ?? touched;
  return match !== undefined
    ? { subscriptionId: match.subscriptionId, tenantId: match.tenantId }
    : undefined;
}

async function handleSubLifecycle(
  tx: DbOrTx,
  deps: SubscriptionDeliveryProcessorDeps,
  provider: string,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<Subscription | undefined> {
  const tenantId =
    existing?.tenantId ?? (evt.metadata as { paykit_tenant_id?: string }).paykit_tenant_id ?? "";
  if (!tenantId) {
    deps.logger?.warn("sub_lifecycle_missing_tenant", { eventId: evt.eventId });
    return undefined;
  }
  const status = (evt.status ?? "incomplete") as SubscriptionStatus;
  return subscriptionRepo.upsertFromEvent(tx, {
    tenantId,
    ownerId: existing?.ownerId ?? tenantId,
    provider,
    providerSubscriptionId: evt.subscriptionId,
    customerId: evt.customerId,
    priceId: existing?.priceId ?? (evt.metadata as { priceId?: string }).priceId ?? "",
    status: evt.type === "sub.deleted" ? "canceled" : status,
    currencyCode: evt.currencyCode ?? "USD",
    currentPeriodEnd: existing?.currentPeriodEnd ?? evt.eventCreatedAt,
    cancelAtPeriodEnd: existing?.cancelAtPeriodEnd ?? false,
    lastEventCreated: evt.eventCreatedAt,
    metadata: { ...evt.metadata },
  });
}

async function handleInvoicePaid(
  tx: DbOrTx,
  deps: SubscriptionDeliveryProcessorDeps,
  provider: string,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<void> {
  // No invoice id means there is nothing to key the ledger entry on, so this event
  // can never be applied — a genuine no-op, not a timing problem.
  if (!evt.invoiceId) return;
  // A missing subscription row IS a timing problem: the invoice can arrive before
  // the subscription event that creates it. Park and retry rather than swallow.
  if (!existing) {
    throw new SubscriptionNotYetRecorded({
      reason: "subscription_not_found",
      eventId: evt.eventId,
      providerSubscriptionId: evt.subscriptionId,
    });
  }
  if (evt.amountMicros === undefined || evt.amountMicros === "0") {
    deps.onLedgerSkipped?.("zero_amount", { eventId: evt.eventId });
    return;
  }
  const currency = (evt.currencyCode ?? "").toUpperCase();
  if (currency !== LEDGER_CURRENCY) {
    deps.logger?.warn("LEDGER_CURRENCY_MISMATCH", {
      provider,
      currency,
      eventId: evt.eventId,
    });
    deps.onLedgerSkipped?.("currency_mismatch", { eventId: evt.eventId, currency });
    return;
  }
  if (existing.status === "canceled" && existing.currentPeriodEnd < evt.eventCreatedAt) {
    deps.onLedgerSkipped?.("late_invoice_after_cancel", { eventId: evt.eventId });
    return;
  }
  await appendLedgerEntryIdempotent(tx, {
    tenantId: existing.tenantId,
    ownerId: existing.ownerId,
    entryType: "subscription_credit",
    amountMicros: evt.amountMicros,
    currencyCode: currency,
    provider,
    sourceId: evt.invoiceId,
    metadataJson: {
      source: "invoice.paid",
      providerSubscriptionId: evt.subscriptionId,
      eventId: evt.eventId,
    },
  });
}

async function handleInvoiceFailed(
  tx: DbOrTx,
  provider: string,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<void> {
  if (!existing) return;
  await subscriptionRepo.upsertFromEvent(tx, {
    tenantId: existing.tenantId,
    ownerId: existing.ownerId,
    provider,
    providerSubscriptionId: evt.subscriptionId,
    customerId: evt.customerId,
    priceId: existing.priceId,
    status: "past_due",
    currencyCode: evt.currencyCode ?? "USD",
    currentPeriodEnd: existing.currentPeriodEnd,
    cancelAtPeriodEnd: existing.cancelAtPeriodEnd,
    lastEventCreated: evt.eventCreatedAt,
    metadata: { ...evt.metadata },
  });
}

async function handleRefundOrDispute(
  tx: DbOrTx,
  deps: SubscriptionDeliveryProcessorDeps,
  provider: string,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<void> {
  if (!existing) return;
  if (evt.type === "charge.dispute.created") return; // audit-only
  const amount = evt.refundAmountMicros ?? evt.amountMicros;
  if (amount === undefined || amount === "0") return;
  const currency = (evt.currencyCode ?? "").toUpperCase();
  if (currency !== LEDGER_CURRENCY) {
    deps.onLedgerSkipped?.("currency_mismatch", { eventId: evt.eventId, currency });
    return;
  }
  const sourceId =
    evt.type === "charge.refunded"
      ? evt.chargeId
      : evt.type === "charge.dispute.funds_withdrawn"
        ? (evt.metadata as { disputeId?: string }).disputeId
        : (evt.metadata as { creditNoteId?: string }).creditNoteId;
  if (!sourceId) return;
  const entryType =
    evt.type === "charge.refunded"
      ? "refund_debit"
      : evt.type === "charge.dispute.funds_withdrawn"
        ? "dispute_debit"
        : "credit_note_debit";
  await appendLedgerEntryIdempotent(tx, {
    tenantId: existing.tenantId,
    ownerId: existing.ownerId,
    entryType,
    amountMicros: `-${amount.replace(/^-/, "")}`,
    currencyCode: currency,
    provider,
    sourceId,
    metadataJson: {
      source: evt.type,
      providerSubscriptionId: evt.subscriptionId,
      eventId: evt.eventId,
    },
  });
}

async function handleCustomerDeleted(
  tx: DbOrTx,
  provider: string,
  evt: NormalizedSubscriptionEvent,
): Promise<void> {
  const subs = await subscriptionRepo.listActiveByCustomer(tx, provider, evt.customerId);
  for (const s of subs) {
    await subscriptionRepo.markCanceled(tx, provider, s.providerSubscriptionId, evt.eventCreatedAt);
    await appendSubscriptionEvent(tx, {
      subscriptionId: s.subscriptionId,
      provider,
      eventType: "customer.deleted",
      rawPayload: { eventId: evt.eventId, cause: "customer_deleted_cascade" },
    });
  }
  await customerRepo.deleteCustomerForCascade(tx, provider, evt.customerId);
}

/**
 * The subscription this delivery belongs to is not recorded yet. Retryable until
 * the attempt cap, then dead-lettered — reaching the cap means a customer may
 * have paid an invoice whose subscription never arrived, which should page
 * someone.
 */
async function recordUnmatched(
  deps: SubscriptionDeliveryProcessorDeps,
  row: WebhookInboxRow,
  err: SubscriptionNotYetRecorded,
  now: Date,
): Promise<SubscriptionDeliveryResult> {
  deps.logger?.warn("subscription delivery parked — its subscription is not recorded yet", {
    provider: row.provider,
    eventId: row.eventId,
    ...err.detail,
    attempts: row.processingAttempts,
  });

  if (row.processingAttempts >= INBOX_MAX_ATTEMPTS) {
    const reason = `no subscription matched this event after ${INBOX_MAX_ATTEMPTS} attempts`;
    await markDeliveryDeadLettered(deps.db, {
      inboxId: row.inboxId,
      errorCode: "NO_MATCHING_SUBSCRIPTION",
      errorMessage: reason,
      now,
    });
    deps.emitMetric?.("paykit_webhook_dead_letter_total", { provider: row.provider });
    return { kind: "dead_letter", reason };
  }

  await markDeliveryUnmatched(deps.db, {
    inboxId: row.inboxId,
    nextRetryAt: retryAt(deps, row.processingAttempts, now),
    reason: "no subscription matches this event yet",
    now,
  });
  deps.emitMetric?.("paykit_webhook_unmatched_total", { provider: row.provider });
  return { kind: "unmatched" };
}

/** Processing threw. Retryable until the cap, then dead-lettered. */
async function recordFailure(
  deps: SubscriptionDeliveryProcessorDeps,
  row: WebhookInboxRow,
  err: unknown,
  now: Date,
): Promise<SubscriptionDeliveryResult> {
  const message = err instanceof Error ? err.message : String(err);
  deps.logger?.warn("subscription delivery processing failed", {
    provider: row.provider,
    eventId: row.eventId,
    attempts: row.processingAttempts,
    error: message,
  });

  if (row.processingAttempts >= INBOX_MAX_ATTEMPTS) {
    await markDeliveryDeadLettered(deps.db, {
      inboxId: row.inboxId,
      errorCode: "PROCESSING_FAILED",
      errorMessage: message,
      now,
    });
    deps.emitMetric?.("paykit_webhook_dead_letter_total", { provider: row.provider });
    return { kind: "dead_letter", reason: message };
  }

  await markDeliveryFailed(deps.db, {
    inboxId: row.inboxId,
    nextRetryAt: retryAt(deps, row.processingAttempts, now),
    errorCode: "PROCESSING_FAILED",
    errorMessage: message,
    now,
  });
  deps.emitMetric?.("paykit_webhook_retry_total", { provider: row.provider });
  return { kind: "failed", error: message };
}

function retryAt(deps: SubscriptionDeliveryProcessorDeps, attempts: number, now: Date): Date {
  return nextAttemptAt({
    attempts,
    baseDelayMs: INBOX_BASE_RETRY_MS,
    maxDelayMs: INBOX_MAX_RETRY_MS,
    now,
    ...(deps.random !== undefined ? { random: deps.random } : {}),
  });
}

/**
 * Read the stored event back.
 *
 * The stored copy is used rather than re-parsing the raw body, because the raw
 * body is redacted on the way in and an adapter's parser may have changed since.
 * JSONB flattens Date to an ISO string, so `eventCreatedAt` is revived here — the
 * last-write-wins comparisons depend on it being a real Date.
 */
function subscriptionEventFrom(row: WebhookInboxRow): NormalizedSubscriptionEvent | undefined {
  const stored = row.normalizedPayload;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const candidate = stored as Record<string, unknown>;
  if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0) return undefined;
  if (typeof candidate.type !== "string") return undefined;
  // customer.deleted carries an empty subscriptionId by contract; it must still
  // be a string so the repo lookups receive what they expect.
  if (typeof candidate.subscriptionId !== "string") return undefined;
  if (typeof candidate.customerId !== "string") return undefined;

  const eventCreatedAt = reviveDate(candidate.eventCreatedAt);
  if (eventCreatedAt === undefined) return undefined;

  const metadata =
    candidate.metadata !== null && typeof candidate.metadata === "object"
      ? (candidate.metadata as Record<string, unknown>)
      : {};

  return {
    ...(candidate as unknown as NormalizedSubscriptionEvent),
    eventCreatedAt,
    metadata,
  };
}

function reviveDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
