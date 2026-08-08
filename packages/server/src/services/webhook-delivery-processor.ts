/**
 * Processing one recorded webhook delivery.
 *
 * This is the second of the two transactions the inbox splits a webhook into. The
 * first one only recorded that the delivery arrived; this one matches it to a
 * payment, applies the business rules, and records the outcome on the inbox row.
 *
 * The same function serves the request path and the retry worker, deliberately: a
 * delivery that could not be matched when it arrived is retried later, and if the
 * retry applied different rules then money would move differently depending on
 * which attempt happened to succeed.
 *
 * Ordering that matters:
 *
 *   - The business work and `processed` land in ONE transaction. That is what makes
 *     "marked done" and "actually done" the same fact — the failure the inbox
 *     exists to prevent was a row marked done by a path that did nothing.
 *   - No match is `unmatched`, never `processed`. The checkout may still be
 *     mid-flight, so "no payment for this reference" is a timing fact, not a
 *     verdict, and the delivery stays retryable.
 *   - Lifecycle events are emitted only after the commit, so a handler throw
 *     cannot roll back a ledger write.
 *
 * A crash between the commit and the response is safe: the lease expires, the
 * delivery is retried, and the retry credits nothing twice because the ledger's
 * UNIQUE (provider, source_id, entry_type) collapses the repeat.
 */
import type { NormalizedWebhookEvent } from "@vibecc/paykit";
import { nextAttemptAt } from "@vibecc/paykit";
import type { DbClient } from "@vibecc/paykit-auth-core/db/client.js";
import {
  markDeliveryDeadLettered,
  markDeliveryFailed,
  markDeliveryProcessed,
  markDeliveryUnmatched,
} from "@vibecc/paykit-auth-core/db/repos/webhook-inbox.repo.js";
import { paymentTransactions } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import type { WebhookInboxRow } from "@vibecc/paykit-auth-core/db/schema/webhook-inbox.js";
import { and, eq } from "drizzle-orm";
import type { PaykitEventHandlers } from "../events/emitter.js";
import { emitEvent } from "../events/emitter.js";
import {
  type PaymentEventOutcome,
  applyPaymentEvent,
} from "../routes/webhooks/payment-event-processor.js";
import {
  INBOX_BASE_RETRY_MS,
  INBOX_MAX_ATTEMPTS,
  INBOX_MAX_RETRY_MS,
} from "./webhook-inbox-policy.js";

export interface DeliveryProcessorDeps {
  readonly db: DbClient;
  readonly events: PaykitEventHandlers;
  /** True when a screening service is configured, so credits are deferred. */
  readonly screeningConfigured: boolean;
  /** Per-provider flag; false only for payer-controlled rails. */
  readonly settlesExactAmount: (provider: string) => boolean;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  /** Injectable so a test can assert the retry schedule instead of sleeping. */
  readonly random?: () => number;
  readonly now?: () => Date;
}

export type DeliveryResult =
  | {
      readonly kind: "processed";
      readonly transactionId: string;
      readonly screeningEnqueued: boolean;
    }
  | { readonly kind: "unmatched" }
  | { readonly kind: "dead_letter"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: string }
  /** The row moved on between the claim and this call — someone else owns it. */
  | { readonly kind: "not_claimable" };

/**
 * Apply a claimed delivery. The caller must already hold the claim: this function
 * assumes the row is in `processing` and that its own lease has not expired.
 */
export async function processDelivery(
  deps: DeliveryProcessorDeps,
  row: WebhookInboxRow,
): Promise<DeliveryResult> {
  const now = deps.now?.() ?? new Date();
  const evt = normalizedEventFrom(row);
  if (evt === undefined) {
    // A row whose stored payload cannot be read back as an event is not retryable:
    // every attempt would fail the same way. Dead-letter it so a human sees it
    // instead of it cycling until the attempt cap.
    const reason = "stored normalized payload is not a usable webhook event";
    await markDeliveryDeadLettered(deps.db, {
      inboxId: row.inboxId,
      errorCode: "UNREADABLE_PAYLOAD",
      errorMessage: reason,
      now,
    });
    deps.emitMetric?.("paykit_webhook_dead_letter_total", { provider: row.provider });
    return { kind: "dead_letter", reason };
  }

  let outcome: PaymentEventOutcome | undefined;
  let matchedRow: { transactionId: string; tenantId: string } | undefined;

  try {
    await deps.db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(paymentTransactions)
        .where(
          and(
            eq(paymentTransactions.provider, row.provider),
            eq(paymentTransactions.providerRef, evt.providerRef),
          ),
        )
        .for("update")
        .limit(1);
      if (payment === undefined) return;

      matchedRow = { transactionId: payment.transactionId, tenantId: payment.tenantId };
      outcome = await applyPaymentEvent(tx, payment, evt, {
        provider: row.provider,
        settlesExactAmount: deps.settlesExactAmount(row.provider),
        screeningConfigured: deps.screeningConfigured,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
      });

      // Marked done in the same transaction as the work itself, so the two can
      // never disagree. A rollback below takes this with it and the delivery is
      // retried.
      await markDeliveryProcessed(tx, {
        inboxId: row.inboxId,
        matchedTransactionId: payment.transactionId,
        tenantId: payment.tenantId,
        now,
      });
    });
  } catch (err) {
    return recordFailure(deps, row, err, now);
  }

  if (matchedRow === undefined) return recordUnmatched(deps, row, now);

  const settled = matchedRow;
  if (outcome?.emitFor != null && outcome.transactionId !== null) {
    await emitLifecycleEvent(deps, outcome.emitFor, outcome.transactionId, evt);
  }
  return {
    kind: "processed",
    transactionId: settled.transactionId,
    screeningEnqueued: outcome?.screeningEnqueued === true,
  };
}

/**
 * No payment carries this provider reference yet. Retryable until the attempt cap,
 * then dead-lettered — reaching that cap means money may have moved at the provider
 * with nothing here to match it, which is the case that should page someone.
 */
async function recordUnmatched(
  deps: DeliveryProcessorDeps,
  row: WebhookInboxRow,
  now: Date,
): Promise<DeliveryResult> {
  if (row.processingAttempts >= INBOX_MAX_ATTEMPTS) {
    const reason = `no payment matched this reference after ${INBOX_MAX_ATTEMPTS} attempts`;
    await markDeliveryDeadLettered(deps.db, {
      inboxId: row.inboxId,
      errorCode: "NO_MATCHING_TRANSACTION",
      errorMessage: reason,
      now,
    });
    deps.emitMetric?.("paykit_webhook_dead_letter_total", { provider: row.provider });
    deps.logger?.warn("webhook delivery dead-lettered — never matched a payment", {
      provider: row.provider,
      eventId: row.eventId,
      providerRef: row.providerRef,
      attempts: row.processingAttempts,
    });
    return { kind: "dead_letter", reason };
  }

  await markDeliveryUnmatched(deps.db, {
    inboxId: row.inboxId,
    nextRetryAt: retryAt(deps, row.processingAttempts, now),
    now,
  });
  deps.emitMetric?.("paykit_webhook_unmatched_total", { provider: row.provider });
  return { kind: "unmatched" };
}

/** Processing threw. Retryable until the cap, then dead-lettered. */
async function recordFailure(
  deps: DeliveryProcessorDeps,
  row: WebhookInboxRow,
  err: unknown,
  now: Date,
): Promise<DeliveryResult> {
  const message = err instanceof Error ? err.message : String(err);
  deps.logger?.warn("webhook delivery processing failed", {
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

function retryAt(deps: DeliveryProcessorDeps, attempts: number, now: Date): Date {
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
 * The stored copy is used rather than re-parsing the raw body, because the raw body
 * is redacted on the way in and an adapter's parser may have changed since. Only
 * the fields the pipeline depends on are validated; the rest travel as they were.
 */
function normalizedEventFrom(row: WebhookInboxRow): NormalizedWebhookEvent | undefined {
  const stored = row.normalizedPayload;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const candidate = stored as Record<string, unknown>;
  if (typeof candidate.eventId !== "string" || candidate.eventId.length === 0) return undefined;
  if (typeof candidate.type !== "string") return undefined;
  if (typeof candidate.providerRef !== "string" || candidate.providerRef.length === 0) {
    return undefined;
  }
  return candidate as unknown as NormalizedWebhookEvent;
}

/** Re-read the payment after the commit, so a handler sees committed state. */
async function emitLifecycleEvent(
  deps: DeliveryProcessorDeps,
  type: NormalizedWebhookEvent["type"],
  transactionId: string,
  evt: NormalizedWebhookEvent,
): Promise<void> {
  const [row] = await deps.db
    .select()
    .from(paymentTransactions)
    .where(eq(paymentTransactions.transactionId, transactionId))
    .limit(1);
  if (row === undefined) return;

  const logger = deps.logger ?? { warn: () => {} };
  if (type === "payment.completed") {
    await emitEvent(deps.events, { type: "payment.completed", transaction: row }, logger);
  } else if (type === "payment.refunded") {
    await emitEvent(
      deps.events,
      {
        type: "payment.refunded",
        transaction: row,
        refundAmountMicros: evt.refundAmountMicros ?? "0",
      },
      logger,
    );
  } else if (type === "payment.expired") {
    await emitEvent(deps.events, { type: "payment.expired", transaction: row }, logger);
  } else if (type === "payment.failed") {
    await emitEvent(deps.events, { type: "payment.failed", transaction: row }, logger);
  }
}
