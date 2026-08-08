/**
 * V2 subscription webhook handler — single-tx pipeline.
 *
 * Mounted at POST /webhooks/{adapter.id} per registered SubscriptionAdapter
 * instance (RT F7 per-instance routing). Each instance verifies against its
 * own webhook secret pool — no cross-instance secret bleed.
 *
 * Pipeline (single transaction, RT F1, F9, F10):
 *   1. signature verify       → 401 on fail (no DB writes)
 *   2. parseSubscriptionEvent → 200 + log on null/unknown (no retries)
 *   3. webhook_events INSERT  → PK violation = silent 200 skip (idempotent)
 *   4. cache UPSERT or cascade-cancel (customer.deleted) with last-write-wins
 *   5. subscription_events INSERT (audit, append-only)
 *   6. ledger_entries INSERT for ledger-affecting events (UNIQUE blocks resend)
 *   7. COMMIT — Stripe gets 200 only after full commit
 *
 * Ledger contract (validation Round 3 + RT F1):
 *   - invoice.paid:                 CREDIT  amount_paid       (skip if 0 / non-USD)
 *   - charge.refunded:              DEBIT   amount_refunded
 *   - charge.dispute.funds_withdrawn: DEBIT amount
 *   - credit_note.created:          DEBIT   amount
 *   - charge.dispute.created:       audit-only (no ledger move)
 *
 * customer.deleted (Val S4 Q1):
 *   - SELECT every active/trialing/past_due sub for that customer
 *   - UPDATE each to status='canceled' inside the same tx
 *   - APPEND audit row per sub
 *   - NULL out paykit.customers.provider_customer_id (retain row for audit)
 */
import type {
  NormalizedSubscriptionEvent,
  SubscriptionAdapter,
  SubscriptionStatus,
} from "@vibecc/paykit";
import type { DbClient, DbOrTx } from "@vibecc/paykit-auth-core/db/client.js";
import * as customerRepo from "@vibecc/paykit-auth-core/db/repos/customer.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { appendSubscriptionEvent } from "@vibecc/paykit-auth-core/db/repos/subscription-event.repo.js";
import * as subscriptionRepo from "@vibecc/paykit-auth-core/db/repos/subscription.repo.js";
import { tryRecordWebhookEvent } from "@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js";
import type { Subscription } from "@vibecc/paykit-auth-core/db/schema/subscriptions.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { errorJson } from "../shared/response.js";

const LEDGER_CURRENCY = "USD";

export interface SubscriptionWebhookHandlerDeps {
  readonly db: DbClient;
  readonly adapter: SubscriptionAdapter;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly onLedgerSkipped?: (reason: string, payload: Record<string, unknown>) => void;
}

export function buildSubscriptionWebhookHandler(deps: SubscriptionWebhookHandlerDeps): Hono {
  const app = new Hono();
  app.post(`/${deps.adapter.id}`, async (c) => handle(c, deps));
  return app;
}

async function handle(c: Context, deps: SubscriptionWebhookHandlerDeps): Promise<Response> {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  if (!deps.adapter.verifyWebhookSignature(rawBody, headers)) {
    return errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature");
  }

  let event: NormalizedSubscriptionEvent | null;
  try {
    event = deps.adapter.parseSubscriptionEvent(rawBody, headers);
  } catch (err) {
    deps.logger?.warn("parseSubscriptionEvent threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ received: true, skipped: "parse_error" });
  }
  if (!event) {
    deps.logger?.warn("WEBHOOK_EVENT_UNHANDLED", { provider: deps.adapter.id });
    return c.json({ received: true, skipped: "unhandled" });
  }

  const evt = event;
  try {
    await deps.db.transaction(async (tx) => {
      const dedup = await tryRecordWebhookEvent(tx, deps.adapter.id, evt.eventId);
      if (!dedup.recorded) return;

      if (evt.type === "customer.deleted") {
        await handleCustomerDeleted(tx, deps.adapter.id, evt);
        return;
      }

      const existing = await subscriptionRepo.findByProviderSub(
        tx,
        deps.adapter.id,
        evt.subscriptionId,
      );

      if (evt.type === "sub.created" || evt.type === "sub.updated" || evt.type === "sub.deleted") {
        await handleSubLifecycle(tx, deps, evt, existing);
      } else if (evt.type === "invoice.paid") {
        await handleInvoicePaid(tx, deps, evt, existing);
      } else if (evt.type === "invoice.failed") {
        await handleInvoiceFailed(tx, deps, evt, existing);
      } else if (
        evt.type === "charge.refunded" ||
        evt.type === "charge.dispute.created" ||
        evt.type === "charge.dispute.funds_withdrawn" ||
        evt.type === "credit_note.created"
      ) {
        await handleRefundOrDispute(tx, deps, evt, existing);
      }

      if (existing) {
        await appendSubscriptionEvent(tx, {
          subscriptionId: existing.subscriptionId,
          provider: deps.adapter.id,
          eventType: evt.type,
          rawPayload: { ...evt.metadata, eventId: evt.eventId },
        });
      }
    });
  } catch (err) {
    if (err instanceof EventNotYetApplicable) {
      // Nothing was written — the rollback took the dedup row with it — so the
      // redelivery this 409 asks for will find a clean slate. Distinguished from a
      // handler fault so an operator can tell "waiting on another event" from
      // "something is broken".
      deps.logger?.warn("subscription_webhook_deferred", err.detail);
      return errorJson(
        c,
        409,
        "WEBHOOK_NOT_YET_APPLICABLE",
        "The subscription this event belongs to is not recorded yet. Redeliver.",
      );
    }
    deps.logger?.warn("subscription_webhook_tx_failed", {
      error: err instanceof Error ? err.message : String(err),
      eventId: evt.eventId,
    });
    return errorJson(c, 500, "WEBHOOK_HANDLER_ERROR", "Webhook handler failed");
  }

  return c.json({ received: true });
}

/**
 * Raised when an event cannot be applied YET, as opposed to not needing to be.
 *
 * The dedup row is inserted as the first statement of this transaction, so a plain
 * `return` commits it: the event is permanently marked seen, the route answers 200,
 * the provider stops retrying, and a redelivery is refused by the primary key.
 * For an `invoice.paid` whose subscription row has not been written yet — Stripe can
 * deliver the invoice before the subscription event — that means a customer paid and
 * was never credited, with nothing to replay from.
 *
 * Throwing instead rolls the dedup row back with everything else, and the route
 * answers 5xx so the provider redelivers. This is narrower than the payment inbox:
 * durability depends on the provider's retry policy rather than on a table we own,
 * and an event that stays unmatchable past that window is still lost. It removes the
 * permanent-loss case, not the whole class.
 */
class EventNotYetApplicable extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super("subscription event cannot be applied yet");
    this.name = "EventNotYetApplicable";
  }
}

async function handleSubLifecycle(
  tx: DbOrTx,
  deps: SubscriptionWebhookHandlerDeps,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<void> {
  const tenantId =
    existing?.tenantId ?? (evt.metadata as { paykit_tenant_id?: string }).paykit_tenant_id ?? "";
  if (!tenantId) {
    deps.logger?.warn("sub_lifecycle_missing_tenant", { eventId: evt.eventId });
    return;
  }
  const status = (evt.status ?? "incomplete") as SubscriptionStatus;
  await subscriptionRepo.upsertFromEvent(tx, {
    tenantId,
    ownerId: existing?.ownerId ?? tenantId,
    provider: deps.adapter.id,
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
  deps: SubscriptionWebhookHandlerDeps,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<void> {
  // No invoice id means there is nothing to key the ledger entry on, so this event
  // can never be applied — a genuine no-op, not a timing problem.
  if (!evt.invoiceId) return;
  // A missing subscription row IS a timing problem: the invoice can arrive before
  // the subscription event that creates it. Retry rather than swallow.
  if (!existing) {
    throw new EventNotYetApplicable({
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
      provider: deps.adapter.id,
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
    provider: deps.adapter.id,
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
  deps: SubscriptionWebhookHandlerDeps,
  evt: NormalizedSubscriptionEvent,
  existing: Subscription | undefined,
): Promise<void> {
  if (!existing) return;
  await subscriptionRepo.upsertFromEvent(tx, {
    tenantId: existing.tenantId,
    ownerId: existing.ownerId,
    provider: deps.adapter.id,
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
  deps: SubscriptionWebhookHandlerDeps,
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
    provider: deps.adapter.id,
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
  providerId: string,
  evt: NormalizedSubscriptionEvent,
): Promise<void> {
  const subs = await subscriptionRepo.listActiveByCustomer(tx, providerId, evt.customerId);
  for (const s of subs) {
    await subscriptionRepo.markCanceled(
      tx,
      providerId,
      s.providerSubscriptionId,
      evt.eventCreatedAt,
    );
    await appendSubscriptionEvent(tx, {
      subscriptionId: s.subscriptionId,
      provider: providerId,
      eventType: "customer.deleted",
      rawPayload: { eventId: evt.eventId, cause: "customer_deleted_cascade" },
    });
  }
  await customerRepo.deleteCustomerForCascade(tx, providerId, evt.customerId);
}
