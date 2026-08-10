/**
 * Stripe webhook event → NormalizedSubscriptionEvent mapper.
 *
 * 10 event types (RT F1, Val S4 Q1):
 *   sub.created / sub.updated / sub.deleted
 *   invoice.paid / invoice.failed
 *   charge.refunded / charge.dispute.created / charge.dispute.funds_withdrawn
 *   credit_note.created
 *   customer.deleted
 *
 * Returns null for any other Stripe event type — caller treats it as
 * uninteresting and ACKs without dispatch.
 */
import type { NormalizedSubscriptionEvent, SubscriptionEventType } from "@xeko-git-1/paykit";
import { stripeUsdAmountToMicros } from "@xeko-git-1/paykit";
import type Stripe from "stripe";
import { mapStripeStatus } from "./status-mapper.js";

const STRIPE_TO_PAYKIT: Record<string, SubscriptionEventType> = {
  "customer.subscription.created": "sub.created",
  "customer.subscription.updated": "sub.updated",
  "customer.subscription.deleted": "sub.deleted",
  "invoice.paid": "invoice.paid",
  "invoice.payment_failed": "invoice.failed",
  "charge.refunded": "charge.refunded",
  "charge.dispute.created": "charge.dispute.created",
  "charge.dispute.funds_withdrawn": "charge.dispute.funds_withdrawn",
  "credit_note.created": "credit_note.created",
  "customer.deleted": "customer.deleted",
};

export function isHandledEventType(stripeType: string): boolean {
  return stripeType in STRIPE_TO_PAYKIT;
}

export function getHandledEventTypes(): readonly string[] {
  return Object.keys(STRIPE_TO_PAYKIT);
}

interface SubLikePayload {
  readonly subscriptionId: string;
  readonly customerId: string;
}

function extractSubAndCustomer(event: Stripe.Event): SubLikePayload | null {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      return {
        subscriptionId: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const sub =
        typeof (inv as unknown as { subscription?: string | Stripe.Subscription }).subscription ===
        "string"
          ? ((inv as unknown as { subscription: string }).subscription)
          : (inv as unknown as { subscription?: Stripe.Subscription }).subscription?.id;
      if (sub === undefined) return null;
      const cust = typeof inv.customer === "string" ? inv.customer : (inv.customer?.id ?? "");
      if (cust === "") return null;
      return { subscriptionId: sub, customerId: cust };
    }
    case "charge.refunded":
    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn": {
      // Charge events; subscription pulled from charge.metadata.paykit_subscription_id
      // (set by Phase 06 dispatcher when charge belongs to a sub invoice). Without
      // that linkage Phase 06 looks up via invoice→subscription resolution.
      const charge = event.data.object as Stripe.Charge | Stripe.Dispute;
      if ("customer" in charge && charge.customer !== null) {
        const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer.id;
        const subId =
          typeof charge.metadata?.paykit_subscription_id === "string"
            ? charge.metadata.paykit_subscription_id
            : "";
        return { subscriptionId: subId, customerId };
      }
      return null;
    }
    case "credit_note.created": {
      const note = event.data.object as Stripe.CreditNote;
      const cust = typeof note.customer === "string" ? note.customer : note.customer.id;
      const subId =
        typeof note.metadata?.paykit_subscription_id === "string"
          ? note.metadata.paykit_subscription_id
          : "";
      return { subscriptionId: subId, customerId: cust };
    }
    case "customer.deleted": {
      const cust = event.data.object as Stripe.Customer;
      // No subscription scope — customer.deleted cascades to ALL active subs
      // via Phase 06 handler. We pass empty subscriptionId; handler treats it
      // as "every sub for this customer".
      return { subscriptionId: "", customerId: cust.id };
    }
    default:
      return null;
  }
}

export function mapEvent(event: Stripe.Event): NormalizedSubscriptionEvent | null {
  const paykitType = STRIPE_TO_PAYKIT[event.type];
  if (!paykitType) return null;

  const ids = extractSubAndCustomer(event);
  if (!ids) return null;

  const eventCreatedAt = new Date((event.created ?? 0) * 1000);

  const baseMetadata: Record<string, unknown> = {
    stripeEventType: event.type,
  };

  switch (paykitType) {
    case "sub.created":
    case "sub.updated":
    case "sub.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const status = mapStripeStatus(sub.status);
      const result: NormalizedSubscriptionEvent = {
        eventId: event.id,
        type: paykitType,
        subscriptionId: ids.subscriptionId,
        customerId: ids.customerId,
        status: status.status,
        eventCreatedAt,
        metadata: { ...baseMetadata, statusFallback: status.fallback, statusRaw: status.raw },
      };
      return result;
    }
    case "invoice.paid":
    case "invoice.failed": {
      const inv = event.data.object as Stripe.Invoice;
      const amountMicros = (() => {
        try {
          const cents = paykitType === "invoice.paid" ? inv.amount_paid : (inv.amount_due ?? 0);
          return stripeUsdAmountToMicros(cents, inv.currency ?? "usd").toString();
        } catch {
          return undefined;
        }
      })();
      const result: NormalizedSubscriptionEvent = {
        eventId: event.id,
        type: paykitType,
        subscriptionId: ids.subscriptionId,
        customerId: ids.customerId,
        eventCreatedAt,
        metadata: { ...baseMetadata, invoiceNumber: inv.number ?? null },
        ...(amountMicros !== undefined ? { amountMicros } : {}),
        currencyCode: (inv.currency ?? "usd").toUpperCase(),
        ...(typeof inv.id === "string" ? { invoiceId: inv.id } : {}),
      };
      return result;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      let refundMicros: string | undefined;
      try {
        refundMicros = stripeUsdAmountToMicros(
          charge.amount_refunded,
          charge.currency ?? "usd",
        ).toString();
      } catch {
        refundMicros = undefined;
      }
      const result: NormalizedSubscriptionEvent = {
        eventId: event.id,
        type: paykitType,
        subscriptionId: ids.subscriptionId,
        customerId: ids.customerId,
        eventCreatedAt,
        metadata: { ...baseMetadata, refundIds: charge.refunds?.data?.map((r) => r.id) ?? [] },
        currencyCode: (charge.currency ?? "usd").toUpperCase(),
        chargeId: charge.id,
        ...(refundMicros !== undefined ? { refundAmountMicros: refundMicros } : {}),
      };
      return result;
    }
    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn": {
      const dispute = event.data.object as Stripe.Dispute;
      let micros: string | undefined;
      try {
        micros = stripeUsdAmountToMicros(
          dispute.amount,
          dispute.currency ?? "usd",
        ).toString();
      } catch {
        micros = undefined;
      }
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
      const result: NormalizedSubscriptionEvent = {
        eventId: event.id,
        type: paykitType,
        subscriptionId: ids.subscriptionId,
        customerId: ids.customerId,
        eventCreatedAt,
        metadata: { ...baseMetadata, disputeId: dispute.id, reason: dispute.reason ?? null },
        currencyCode: (dispute.currency ?? "usd").toUpperCase(),
        chargeId,
        ...(micros !== undefined ? { amountMicros: micros, refundAmountMicros: micros } : {}),
      };
      return result;
    }
    case "credit_note.created": {
      const note = event.data.object as Stripe.CreditNote;
      let micros: string | undefined;
      try {
        micros = stripeUsdAmountToMicros(note.amount, note.currency ?? "usd").toString();
      } catch {
        micros = undefined;
      }
      const result: NormalizedSubscriptionEvent = {
        eventId: event.id,
        type: paykitType,
        subscriptionId: ids.subscriptionId,
        customerId: ids.customerId,
        eventCreatedAt,
        metadata: { ...baseMetadata, creditNoteId: note.id, reason: note.reason ?? null },
        currencyCode: (note.currency ?? "usd").toUpperCase(),
        ...(micros !== undefined ? { amountMicros: micros, refundAmountMicros: micros } : {}),
      };
      return result;
    }
    case "customer.deleted": {
      const result: NormalizedSubscriptionEvent = {
        eventId: event.id,
        type: paykitType,
        subscriptionId: "",
        customerId: ids.customerId,
        eventCreatedAt,
        metadata: { ...baseMetadata },
      };
      return result;
    }
    default:
      return null;
  }
}
