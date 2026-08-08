/**
 * createStripeAdapter — wraps Stripe SDK as PaymentProviderAdapter.
 *
 * V1.5 contract:
 * - id: 'stripe' (or 'stripe:<instance>' for multi-instance)
 * - supportedCurrencies: ['USD']
 * - checkoutMode: 'redirect'
 * - createCheckout: one-time Stripe Checkout Session (mode='payment')
 * - parseWebhookPayload: checkout.session.completed | the refund.* family |
 *   charge.refunded (legacy) | checkout.session.expired
 * - refund: stripe.refunds.create with idempotencyKey
 * - fetchTransactions: paginates checkout.sessions.list
 */
import {
  type CheckoutResult,
  type CreateCheckoutInput,
  type NormalizedWebhookEvent,
  type PaymentProviderAdapter,
  type ProviderTxnRecord,
  type RefundInput,
  type RefundResult,
  UnsupportedCurrencyError,
  stripeUsdAmountToMicros,
} from "@vibecc/paykit";
import Stripe from "stripe";
import { paykitRefs, refundFallbackRef, refundPaymentRef } from "./webhook-events.js";
import { verifyAndParse } from "./webhook-verifier.js";

export interface StripeAdapterConfig {
  readonly id?: string;
  readonly secretKey: string;
  readonly webhookSecret: string | readonly string[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly apiVersion?: Stripe.LatestApiVersion;
  readonly environment?: "sandbox" | "production";
}

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function createStripeAdapter(config: StripeAdapterConfig): PaymentProviderAdapter {
  const stripe = new Stripe(config.secretKey, {
    apiVersion: config.apiVersion ?? ("2025-09-30.clover" as Stripe.LatestApiVersion),
  });
  const id = config.id ?? "stripe";

  // Webhook event ID cache for verifyWebhookSignature (since constructEvent does it inline,
  // we cache the parsed event so parseWebhookPayload doesn't re-verify).
  const eventCache = new Map<string, Stripe.Event>();

  return {
    id,
    displayName: "Stripe",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD") {
        throw new UnsupportedCurrencyError(
          `Stripe adapter supports USD only; received '${input.currencyCode}'`,
        );
      }
      // amountMicros (BigInt) → cents for Stripe (1 USD = 100 cents = 1_000_000 micros)
      const cents = Number(input.amountMicros / 10_000n);
      const sessionMetadata = {
        paykitTransactionId: input.transactionId,
        tenantId: input.tenantId,
        ownerId: input.ownerId,
      };
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Paykit Credits" },
              unit_amount: cents,
            },
            quantity: 1,
          },
        ],
        metadata: sessionMetadata,
        // The SAME metadata again, one level down. Session metadata does not
        // propagate: a PaymentIntent copies its own metadata onto the Charge when
        // the Charge is created, and the only way to set PaymentIntent metadata
        // from Checkout is `payment_intent_data`. Without this, a refund event —
        // which carries a Refund pointing at a Charge, never at the Session —
        // has no way back to the paykit transaction, and a refund initiated from
        // the Stripe Dashboard cannot be attributed at all.
        payment_intent_data: { metadata: sessionMetadata },
        ...(input.customerEmail !== undefined ? { customer_email: input.customerEmail } : {}),
        success_url: `${config.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: config.cancelUrl,
      });
      return {
        webUrl: session.url ?? config.cancelUrl,
        expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS),
        providerSessionId: session.id,
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      const signature = headers["stripe-signature"] ?? headers["Stripe-Signature"] ?? "";
      try {
        const event = verifyAndParse(stripe, rawBody, signature, config.webhookSecret);
        eventCache.set(event.id, event);
        return true;
      } catch {
        return false;
      }
    },

    parseWebhookPayload(
      rawBody: string,
      headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      const signature = headers["stripe-signature"] ?? headers["Stripe-Signature"] ?? "";
      const event = (() => {
        try {
          // Cache hit if verifyWebhookSignature was called first (server-level pattern)
          const fromCache = Array.from(eventCache.values()).find(
            (e) => e.id !== undefined && rawBody.includes(e.id),
          );
          if (fromCache) return fromCache;
          return verifyAndParse(stripe, rawBody, signature, config.webhookSecret);
        } catch {
          return null;
        }
      })();
      if (!event) return null;
      eventCache.delete(event.id);

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.payment_status !== "paid") return null;
          let amountMicros = "0";
          try {
            amountMicros = stripeUsdAmountToMicros(
              session.amount_total ?? 0,
              session.currency ?? "usd",
            ).toString();
          } catch {
            return null;
          }
          return {
            eventId: event.id,
            type: "payment.completed",
            providerRef: session.id,
            amountMicros,
            currencyCode: "USD",
            metadata: {
              paykitTransactionId: session.metadata?.paykitTransactionId,
              tenantId: session.metadata?.tenantId,
              ownerId: session.metadata?.ownerId,
              fixVersion: "v2_micros_corrected",
            },
          };
        }
        case "charge.refunded": {
          const charge = event.data.object as Stripe.Charge;
          // `charge.amount_refunded` is a RUNNING TOTAL across every refund of
          // the charge, so it is not a delta and must never be used as one: the
          // second partial refund would report the sum of both. The Refund
          // objects on the charge each carry their own amount and id, and Stripe
          // returns them newest first, so the most recent one is this event's
          // refund.
          const latestRefund = charge.refunds?.data?.[0];
          const refundAmountMicros = (() => {
            try {
              // Falling back to the cumulative total when no Refund object is
              // present keeps the single-refund case working (the total equals
              // the delta when there has only been one). Such an event also
              // carries no refund id, which the server reads as "this payment
              // can have at most one refund" rather than risking a wrong delta.
              const source = latestRefund?.amount ?? charge.amount_refunded;
              return stripeUsdAmountToMicros(source, charge.currency ?? "usd").toString();
            } catch {
              return undefined;
            }
          })();
          if (refundAmountMicros === undefined) return null;
          return {
            eventId: `refund:${event.id}`,
            type: "payment.refunded",
            providerRef: refundPaymentRef(charge.metadata, charge.id),
            refundAmountMicros,
            currencyCode: "USD",
            ...(latestRefund !== undefined ? { providerRefundId: latestRefund.id } : {}),
            metadata: {
              chargeId: charge.id,
              refundId: latestRefund?.id ?? null,
              ...paykitRefs(charge.metadata),
            },
          };
        }
        case "refund.created":
        case "refund.updated":
        case "refund.failed": {
          // The Refund object is the authoritative per-refund record: its own id
          // and its own amount, which is what a partial refund needs. Stripe
          // recommends these over `charge.refunded` for exactly that reason.
          const refund = event.data.object as Stripe.Refund;
          // Only a settled refund may move money. A refund can be created
          // `pending` and later fail, so crediting on creation would give money
          // back for a refund that never happened; a failed one must leave the
          // balance alone entirely.
          if (refund.status !== "succeeded") return null;
          let refundAmountMicros: string;
          try {
            refundAmountMicros = stripeUsdAmountToMicros(
              refund.amount,
              refund.currency ?? "usd",
            ).toString();
          } catch {
            return null;
          }
          return {
            eventId: `refund:${event.id}`,
            type: "payment.refunded",
            // Prefer the checkout reference this adapter stamped on the refund,
            // because that is what the payment row is keyed on. A refund created
            // outside paykit (the Stripe Dashboard) has no such stamp, so it
            // falls back to the charge or payment intent id.
            providerRef: refundPaymentRef(refund.metadata, refundFallbackRef(refund)),
            refundAmountMicros,
            currencyCode: "USD",
            providerRefundId: refund.id,
            metadata: {
              refundId: refund.id,
              chargeId: typeof refund.charge === "string" ? refund.charge : null,
              ...paykitRefs(refund.metadata),
            },
          };
        }
        case "checkout.session.expired": {
          const session = event.data.object as Stripe.Checkout.Session;
          return {
            eventId: `expired:${event.id}`,
            type: "payment.expired",
            providerRef: session.id,
            metadata: {},
          };
        }
        default:
          return null;
      }
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      // Stripe needs charge id or payment_intent id; we look up via session.
      // Caller (server) provides providerRef hint = checkout session id.
      if (!input.providerRef) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_PROVIDER_REF",
            message: "Stripe refund requires session id via providerRef",
          },
        };
      }
      try {
        const session = await stripe.checkout.sessions.retrieve(input.providerRef, {
          expand: ["payment_intent"],
        });
        const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;
        if (!paymentIntent) {
          return {
            state: "failed",
            error: { providerCode: "NO_PAYMENT_INTENT", message: "Session has no payment intent" },
          };
        }
        const cents = Number(input.amountMicros / 10_000n);
        const refund = await stripe.refunds.create(
          {
            payment_intent: paymentIntent.id,
            amount: cents,
            reason: "requested_by_customer",
            metadata: { paykitTransactionId: input.transactionId, paykitReason: input.reason },
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return {
          state: refund.status === "succeeded" ? "completed" : "pending",
          providerRefundId: refund.id,
        };
      } catch (err) {
        const e = err as Stripe.errors.StripeError;
        return {
          state: "failed",
          error: {
            providerCode: e.code ?? "UNKNOWN",
            message: e.message ?? String(err),
          },
        };
      }
    },

    async fetchTransactions(window): Promise<readonly ProviderTxnRecord[]> {
      const records: ProviderTxnRecord[] = [];
      const created: { gte: number; lt?: number } = {
        gte: Math.floor(window.since.getTime() / 1000),
      };
      if (window.until !== undefined) {
        created.lt = Math.floor(window.until.getTime() / 1000);
      }
      const baseParams: Stripe.Checkout.SessionListParams = { limit: 100, created };
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const fetchParams: Stripe.Checkout.SessionListParams = { ...baseParams };
        if (cursor !== undefined) fetchParams.starting_after = cursor;
        const list = await stripe.checkout.sessions.list(fetchParams);
        for (const s of list.data) {
          if (s.payment_status !== "paid") continue;
          if (s.amount_total === null) continue;
          let micros: bigint;
          try {
            micros = stripeUsdAmountToMicros(s.amount_total, s.currency ?? "usd");
          } catch {
            continue;
          }
          records.push({
            providerRef: s.id,
            amountMicros: micros.toString(),
            currencyCode: "USD",
          });
        }
        if (!list.has_more) break;
        cursor = list.data[list.data.length - 1]?.id;
        if (cursor === undefined) break;
      }
      return records;
    },
  };
}
