/**
 * createStripeAdapter — wraps Stripe SDK as PaymentProviderAdapter.
 *
 * V1.5 contract:
 * - id: 'stripe' (or 'stripe:<instance>' for multi-instance)
 * - supportedCurrencies: ['USD']
 * - checkoutMode: 'redirect'
 * - createCheckout: one-time Stripe Checkout Session (mode='payment')
 * - parseWebhookPayload: handles checkout.session.completed | charge.refunded | checkout.session.expired
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
        metadata: {
          paykitTransactionId: input.transactionId,
          tenantId: input.tenantId,
          ownerId: input.ownerId,
        },
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
          let refundAmountMicros = "0";
          try {
            refundAmountMicros = stripeUsdAmountToMicros(
              charge.amount_refunded,
              charge.currency ?? "usd",
            ).toString();
          } catch {
            return null;
          }
          const checkoutSessionId =
            typeof charge.metadata?.checkoutSessionId === "string"
              ? charge.metadata.checkoutSessionId
              : charge.id;
          return {
            eventId: `refund:${event.id}`,
            type: "payment.refunded",
            providerRef: checkoutSessionId,
            refundAmountMicros,
            currencyCode: "USD",
            metadata: {
              chargeId: charge.id,
              refundId: charge.refunds?.data?.[0]?.id ?? null,
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
