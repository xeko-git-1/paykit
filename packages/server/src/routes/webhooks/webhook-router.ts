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
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { applyDelta } from "../../db/repos/balance.repo.js";
import { commitReservation, releaseReservation } from "../../db/repos/discount.repo.js";
import { appendLedgerEntryIdempotent } from "../../db/repos/ledger.repo.js";
import { updateTransactionStatus } from "../../db/repos/payment.repo.js";
import { findActiveByTransaction, markCompleted } from "../../db/repos/pending-refund.repo.js";
import { tryRecordWebhookEvent } from "../../db/repos/webhook-event.repo.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import type { PaykitEventHandlers } from "../../events/emitter.js";
import { emitEvent } from "../../events/emitter.js";
import { errorJson } from "../shared/response.js";

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

        // V3 Val D7 — onBeforeCredit OFAC/sanctions hook. Tenant-injected
        // screening; throwing quarantines without ledger touch. ACK 200 to
        // provider so retry storm doesn't compound a deliberate block.
        if (deps.onBeforeCredit) {
          try {
            await deps.onBeforeCredit(evt);
          } catch (err) {
            deps.logger?.warn("onBeforeCredit rejected payment — quarantining", {
              provider: adapter.id,
              providerRef: evt.providerRef,
              reason: err instanceof Error ? err.message : String(err),
            });
            await updateTransactionStatus(tx, row.transactionId, "quarantine");
            deps.emitMetric?.("paykit_credit_blocked_total", { provider: adapter.id });
            return;
          }
        }

        // RT F1 idempotent ledger write — UNIQUE (provider, source_id, entry_type)
        // blocks resend double-credit when provider rotates event_id but reuses
        // session/charge id. Phase 0a hotfix routes provider/sourceId through.
        const { inserted } = await appendLedgerEntryIdempotent(tx, {
          tenantId: row.tenantId,
          ownerId: row.ownerId,
          entryType: "credit",
          amountMicros: evt.amountMicros,
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
          await applyDelta(tx, row.tenantId, evt.currencyCode, BigInt(evt.amountMicros));
        }
        const updated = await updateTransactionStatus(tx, row.transactionId, "completed");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.completed";
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

  return c.json({ received: true });
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
