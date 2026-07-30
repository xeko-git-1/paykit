/**
 * Generic webhook router — V1.5.
 *
 * Mounts POST `/{adapterId}` for every adapter in registry. Server-level
 * pipeline:
 *   1. Read raw body
 *   2. adapter.verifyWebhookSignature(rawBody, headers) → 401 if false
 *   3. adapter.parseWebhookPayload(rawBody, headers) → null = silent skip
 *   4. Inside db.transaction:
 *        a. webhook_events INSERT (dedup by (adapterId, event.eventId))
 *        b. SELECT FOR UPDATE on payment_transactions row (red-team CC concurrency)
 *        c. Apply ledger entry + balance projection per event.type
 *        d. Update tx status
 *   5. Emit event via events handler (post-tx commit)
 *
 * Returns 500 on unexpected throw → provider auto-retries (Stripe up to 3 days).
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
} from "@vibecc/paykit";
import type { ScreeningService } from "@vibecc/paykit";
import { microsStringToBigInt, screeningServiceFromOnBeforeCredit } from "@vibecc/paykit";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { DbClient } from "@vibecc/paykit-auth-core/db/client.js";
import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import { commitReservation, releaseReservation } from "@vibecc/paykit-auth-core/db/repos/discount.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { findActiveByTransaction, markCompleted } from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import { enqueueScreeningJob } from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
import { tryRecordWebhookEvent } from "@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js";
import { paymentTransactions } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import type { PaykitEventHandlers } from "../../events/emitter.js";
import { emitEvent } from "../../events/emitter.js";
import { processNextScreeningJob } from "../../services/screening-runner.js";
import { errorJson } from "../shared/response.js";
import { evaluateSettlementAmount } from "./settlement-amount-guard.js";

export interface WebhookRouterDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly events: PaykitEventHandlers;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  /**
   * V3 (Val Session 2 D7) — BYOC OFAC/sanctions screening hook.
   *
   * Fires BEFORE appendLedgerEntryIdempotent on payment.completed. Throwing
   * aborts the credit; ledger NOT touched; status='quarantine' applied;
   * metric paykit_credit_blocked_total{provider} emitted via metrics callback.
   * Default: no-op. Tenants inject Chainalysis Reactor / TRM Labs / Elliptic
   * Lens here. See docs/compliance-onbeforecredit.md for reference impls.
   */
  readonly onBeforeCredit?: (evt: NormalizedWebhookEvent) => Promise<void>;
  /**
   * Compliance screening service, called OUTSIDE this transaction.
   *
   * When either this or `onBeforeCredit` is configured, `payment.completed`
   * parks the payment in `screening_pending` and enqueues a job instead of
   * crediting inline; the screening runner applies the verdict. Leaving both
   * unset keeps the original inline credit path exactly as it was.
   */
  readonly screeningService?: ScreeningService;
  /** Optional metrics counter emitter — default no-op. */
  readonly emitMetric?: (
    name: string,
    labels: Record<string, string>,
    value?: number,
  ) => void;
}

export function buildWebhookRouter(deps: WebhookRouterDeps): Hono {
  const app = new Hono();

  // Mount one POST handler per registered adapter id.
  for (const adapter of deps.registry.list()) {
    app.post(`/${adapter.id}`, async (c) => handleWebhook(c, adapter, deps));
  }

  return app;
}

async function handleWebhook(
  c: Context,
  adapter: PaymentProviderAdapter,
  deps: WebhookRouterDeps,
): Promise<Response> {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let event: NormalizedWebhookEvent | null;

  if (adapter.resolveWebhook) {
    // Unsigned-webhook providers (BitPay): the IPN is an untrusted trigger.
    // The adapter authenticates by fetching authoritative status from the
    // provider API. A null/throw here means unauthentic or non-crediting —
    // ACK 200 so the provider stops retrying a request we deliberately ignore.
    try {
      event = await adapter.resolveWebhook(rawBody, headers);
    } catch (err) {
      deps.logger?.warn(`adapter '${adapter.id}' resolveWebhook threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorJson(c, 502, "WEBHOOK_RESOLVE_ERROR", "Adapter could not resolve webhook");
    }
  } else {
    // 1. Signature verify (signed-webhook providers)
    if (!adapter.verifyWebhookSignature(rawBody, headers)) {
      return errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature");
    }

    // 2. Parse → NormalizedWebhookEvent | null
    try {
      event = adapter.parseWebhookPayload(rawBody, headers);
    } catch (err) {
      deps.logger?.warn(`adapter '${adapter.id}' parseWebhookPayload threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorJson(c, 400, "WEBHOOK_PARSE_ERROR", "Adapter could not parse payload");
    }
  }
  if (!event) {
    return c.json({ received: true, skipped: "adapter_returned_null" });
  }

  let processedTxId: string | null = null;
  let eventTypeProcessed: NormalizedWebhookEvent["type"] | null = null;
  // Set when this delivery parked a payment for screening, so the verdict can be
  // attempted once the transaction has committed and released its row lock.
  let screeningEnqueued = false;

  // Capture in local const so TS narrowing works inside the transaction closure.
  const evt: NormalizedWebhookEvent = event;

  await deps.db.transaction(async (tx) => {
    // 3. Dedup by (adapterId, event.eventId)
    const dedup = await tryRecordWebhookEvent(tx, adapter.id, evt.eventId);
    if (!dedup.recorded) return;

    // 4. SELECT FOR UPDATE the payment_transactions row by (provider, provider_ref)
    const [row] = await tx
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, adapter.id),
          eq(paymentTransactions.providerRef, evt.providerRef),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return;

    // 5. Apply state transition per event type
    switch (evt.type) {
      case "payment.completed": {
        if (row.status !== "pending") return;
        if (evt.amountMicros === undefined || evt.currencyCode === undefined) return;

        // Payer-controlled-amount rails (bank transfer): a memo match proves
        // intent, not amount, so compare requested vs received before crediting.
        // Exact-settling rails short-circuit and keep their verified path.
        const settlement = evaluateSettlementAmount({
          settlesExactAmount: adapter.settlesExactAmount !== false,
          requestedMicros: row.amountMicros,
          receivedMicros: evt.amountMicros,
        });
        if (settlement.decision === "underpaid") {
          // Short transfer: no ledger move, status stays 'pending' so the admin
          // can reconcile (or the payer can top up). Emitting no event keeps
          // `completed` meaning paid-in-full for every downstream consumer.
          deps.logger?.warn("payment underpaid — received < requested; not crediting", {
            provider: adapter.id,
            providerRef: evt.providerRef,
            requestedMicros: settlement.requestedMicros,
            receivedMicros: settlement.receivedMicros,
            shortfallMicros: settlement.shortfallMicros,
          });
          deps.emitMetric?.("paykit_underpaid_received_total", { provider: adapter.id });
          return;
        }
        if (settlement.decision === "unreadable_amount") {
          // Neither amount can be trusted, so crediting would be guesswork.
          // Quarantine for admin reconcile rather than leaving it pending: a
          // malformed amount is a defect, not a payer action to wait on.
          deps.logger?.warn("payment amount unreadable — quarantining without credit", {
            provider: adapter.id,
            providerRef: evt.providerRef,
            unreadable: settlement.reason,
          });
          await updateTransactionStatus(tx, row.transactionId, "quarantine");
          deps.emitMetric?.("paykit_amount_unreadable_total", { provider: adapter.id });
          await releaseDiscountReservation(tx, row.metadataJson);
          return;
        }
        if (settlement.decision === "overpaid") {
          // Credit what was requested and leave the overage for manual
          // reconciliation — the happy path must not block on generosity.
          deps.logger?.warn("payment overpaid — crediting requested amount only", {
            provider: adapter.id,
            providerRef: evt.providerRef,
            requestedMicros: settlement.requestedMicros,
            receivedMicros: settlement.receivedMicros,
            overageMicros: settlement.overageMicros,
          });
          deps.emitMetric?.("paykit_overpaid_total", { provider: adapter.id });
        }
        const creditMicros = settlement.creditMicros;

        // The webhook's currency must match the currency the payment was priced
        // in. Wallets are keyed (tenant_id, currency_code), so an event claiming
        // a different currency does not fail on its own — it credits a DIFFERENT
        // wallet, which reads downstream as the customer never having paid while
        // a phantom balance appears in a currency they never used.
        if (evt.currencyCode !== row.currencyCode) {
          deps.logger?.warn("webhook currency does not match transaction — quarantining", {
            provider: adapter.id,
            providerRef: evt.providerRef,
            transactionCurrency: row.currencyCode,
            eventCurrency: evt.currencyCode,
          });
          await updateTransactionStatus(tx, row.transactionId, "quarantine");
          deps.emitMetric?.("paykit_currency_mismatch_total", { provider: adapter.id });
          // Terminal for this payment — free any discount reservation.
          await releaseDiscountReservation(tx, row.metadataJson);
          return;
        }

        // Compliance screening is an outbound call to a tenant-supplied service.
        // It must not run here: this transaction holds a FOR UPDATE lock on the
        // payment row (taken above) plus a pooled connection, and a slow
        // screening provider would hold both for its entire latency while every
        // redelivery of this webhook queues behind the lock.
        //
        // Instead the payment is parked in a durable state and a job is enqueued;
        // the verdict is applied by the screening runner in a separate
        // transaction. The park is what makes this crash-safe — a process death
        // before the verdict leaves a claimable job, not a lost payment.
        if (deps.screeningService !== undefined || deps.onBeforeCredit !== undefined) {
          await parkForScreening(tx, row.transactionId);
          await enqueueScreeningJob(tx, {
            transactionId: row.transactionId,
            tenantId: row.tenantId,
            ownerId: row.ownerId,
            provider: adapter.id,
            // Same ledger idempotency key the inline credit would have used, so
            // the deferred credit still collapses with a provider resend.
            sourceId: evt.providerRef,
            creditMicros,
            currencyCode: row.currencyCode,
            eventJson: { ...evt },
          });
          deps.emitMetric?.("paykit_screening_pending_total", { provider: adapter.id });
          screeningEnqueued = true;
          // The discount reservation stays held: the payment is not resolved yet,
          // and the verdict path commits or releases it.
          return;
        }

        // RT F1 idempotent ledger write — UNIQUE (provider, source_id, entry_type)
        // blocks resend double-credit when provider rotates event_id but reuses
        // session/charge id. Phase 0a hotfix routes provider/sourceId through.
        const { inserted } = await appendLedgerEntryIdempotent(tx, {
          tenantId: row.tenantId,
          ownerId: row.ownerId,
          entryType: "credit",
          amountMicros: creditMicros,
          currencyCode: evt.currencyCode,
          provider: adapter.id,
          sourceId: evt.providerRef,
          metadataJson: {
            source: "payment",
            provider: adapter.id,
            transactionId: row.transactionId,
            ...evt.metadata,
          },
        });
        if (inserted) {
          await applyDelta(tx, row.tenantId, evt.currencyCode, microsStringToBigInt(creditMicros));
        }
        const updated = await updateTransactionStatus(tx, row.transactionId, "completed");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.completed";
        }
        // Persist the provider-side payment id when it differs from provider_ref
        // (NowPayments: refund keys on the numeric payment_id, which only arrives
        // in this IPN — provider_ref holds order_id for the lookup above).
        if (evt.providerPaymentId !== undefined) {
          await tx
            .update(paymentTransactions)
            .set({ providerPaymentId: evt.providerPaymentId, updatedAt: new Date() })
            .where(eq(paymentTransactions.transactionId, row.transactionId));
        }
        // Commit a discount reservation now that the payment is final. Guarded
        // by reserved > 0 in the repo so a resent webhook cannot double-count.
        // Only the service v1 checkout stamps a discountId; embedded BYO-
        // resolver checkouts never do, so this is a no-op there.
        await commitDiscountReservation(tx, row.metadataJson);
        break;
      }
      case "payment.refunded": {
        if (evt.refundAmountMicros === undefined || evt.currencyCode === undefined) return;
        const refundMicros = BigInt(evt.refundAmountMicros);
        // RT F1 + F10 idempotent refund — admin sync-success and webhook-refunded
        // for the same payment_id collapse to one ledger refund_debit row.
        const { inserted } = await appendLedgerEntryIdempotent(tx, {
          tenantId: row.tenantId,
          ownerId: row.ownerId,
          entryType: "refund",
          amountMicros: (-refundMicros).toString(),
          currencyCode: evt.currencyCode,
          provider: adapter.id,
          sourceId: evt.providerRef,
          metadataJson: {
            source: "refund",
            provider: adapter.id,
            originalTransactionId: row.transactionId,
            ...evt.metadata,
          },
        });
        if (inserted) {
          await applyDelta(tx, row.tenantId, evt.currencyCode, -refundMicros);
        }

        // Release any active reservations for this transaction+provider so that
        // remaining is not double-counted (once via the committed ledger entry
        // above, once via a stale queued/processing reservation). For concurrent
        // partial refunds on async providers, releasing all active reservations
        // for the tx errs toward freeing headroom (conservative: remaining goes
        // UP, never enables over-refund). The correct reservation is always
        // released; extras are rare and harmless (they just free stuck headroom).
        const activeReservations = await findActiveByTransaction(tx, {
          provider: adapter.id,
          transactionId: row.transactionId,
        });
        for (const reservation of activeReservations) {
          await markCompleted(tx, reservation.pendingId);
        }

        const updated = await updateTransactionStatus(tx, row.transactionId, "refunded");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.refunded";
        }
        break;
      }
      case "payment.expired": {
        if (row.status !== "pending") return;
        const updated = await updateTransactionStatus(tx, row.transactionId, "expired");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.expired";
        }
        // The payment will never complete — free any discount reservation.
        await releaseDiscountReservation(tx, row.metadataJson);
        break;
      }
      case "payment.failed": {
        if (row.status !== "pending") return;
        const updated = await updateTransactionStatus(tx, row.transactionId, "failed");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.failed";
        }
        // The payment will never complete — free any discount reservation.
        await releaseDiscountReservation(tx, row.metadataJson);
        break;
      }
      case "payment.underpaid": {
        // V3 Val D2 — audit trail only, NO ledger move. Customer paid less
        // than charge; admin reconciles via /admin/billing/ledger/adjust.
        deps.logger?.warn("payment.underpaid received — no ledger move", {
          provider: adapter.id,
          providerRef: evt.providerRef,
          actualAmountMicros: evt.amountMicros,
          expectedAmountMicros: evt.expectedAmountMicros,
        });
        deps.emitMetric?.("paykit_underpaid_received_total", { provider: adapter.id });
        // status remains 'pending' — admin sees row + audit context to decide
        eventTypeProcessed = "payment.underpaid";
        processedTxId = row.transactionId;
        break;
      }
      case "payment.amount_mismatch": {
        // V3 Val D3 — webhook amount drift > 5 bps. Quarantine; admin
        // reconciles via /admin/billing/ledger/adjust. Migration 010 enum
        // ('quarantine') ships in v0.2.1.
        deps.logger?.warn("payment.amount_mismatch — quarantining", {
          provider: adapter.id,
          providerRef: evt.providerRef,
          actualAmountMicros: evt.amountMicros,
          expectedAmountMicros: evt.expectedAmountMicros,
        });
        const updated = await updateTransactionStatus(tx, row.transactionId, "quarantine");
        deps.emitMetric?.("paykit_amount_mismatch_total", { provider: adapter.id });
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.amount_mismatch";
        }
        // Quarantine is terminal for this payment — free any discount reservation.
        await releaseDiscountReservation(tx, row.metadataJson);
        break;
      }
      default:
        // 'unknown' — already deduped, no DB writes
        break;
    }
  });

  // 6. Emit event AFTER transaction commits (handler errors don't roll back)
  if (processedTxId !== null && eventTypeProcessed !== null) {
    const txId: string = processedTxId;
    const [row] = await deps.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, txId))
      .limit(1);
    if (row !== undefined) {
      const eventLogger = deps.logger ?? { warn: () => {} };
      const t = eventTypeProcessed as NormalizedWebhookEvent["type"];
      if (t === "payment.completed") {
        await emitEvent(deps.events, { type: "payment.completed", transaction: row }, eventLogger);
      } else if (t === "payment.refunded") {
        const refundMicros = event?.refundAmountMicros ?? "0";
        await emitEvent(
          deps.events,
          { type: "payment.refunded", transaction: row, refundAmountMicros: refundMicros },
          eventLogger,
        );
      } else if (t === "payment.expired") {
        await emitEvent(deps.events, { type: "payment.expired", transaction: row }, eventLogger);
      } else if (t === "payment.failed") {
        await emitEvent(deps.events, { type: "payment.failed", transaction: row }, eventLogger);
      }
    }
  }

  // 7. Screening verdict, attempted only now that the transaction has committed
  // and the payment row lock is gone. Doing it here rather than only from a cron
  // keeps the common case (a screening service that answers quickly) as fast as
  // the previous inline hook was, without the row lock being held across the call.
  //
  // Every failure mode is swallowed deliberately: the job row is the durable
  // record, so an error here means the verdict lands on a later attempt, while
  // returning non-2xx would make the provider redeliver an event that was already
  // processed. The payment stays uncredited in the meantime, which is the safe
  // direction — a screening that has not answered must never read as permission.
  if (screeningEnqueued) {
    const screeningService = resolveScreeningService(deps);
    if (screeningService !== undefined) {
      try {
        await processNextScreeningJob({
          db: deps.db,
          screeningService,
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
          ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
        });
      } catch (err) {
        deps.logger?.warn("screening verdict deferred — job left for a later attempt", {
          provider: adapter.id,
          providerRef: evt.providerRef,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return c.json({ received: true });
}

/**
 * The screening service to apply verdicts with.
 *
 * An explicit `screeningService` wins; otherwise the legacy `onBeforeCredit` hook
 * is adapted onto the same contract so tenants configured the old way keep the
 * behaviour they have (a throw quarantines the payment) without having to change
 * anything. Returns undefined when neither is configured, in which case nothing
 * was ever enqueued.
 */
function resolveScreeningService(deps: WebhookRouterDeps): ScreeningService | undefined {
  if (deps.screeningService !== undefined) return deps.screeningService;
  if (deps.onBeforeCredit !== undefined) {
    return screeningServiceFromOnBeforeCredit(deps.onBeforeCredit);
  }
  return undefined;
}

/**
 * Park a payment in `screening_pending`, guarded on it still being `pending`.
 *
 * The guard makes the park itself the exactly-once gate: two concurrent
 * deliveries of the same completion event cannot both park (and therefore both
 * enqueue), and a payment that some other path already moved on from is left
 * alone. Written here rather than through the status repo because the repo's
 * transition helper is shared with paths that must not be able to reach this
 * state.
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
        eq(paymentTransactions.status, "pending"),
      ),
    )
    .returning({ transactionId: paymentTransactions.transactionId });
  return parked;
}

// ---------------------------------------------------------------------------
// Discount reservation lifecycle — tx.metadataJson.discountId is set only by
// the service v1 checkout when a promo code was reserved. These extract it and
// move the reservation to its terminal state inside the webhook transaction.
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
