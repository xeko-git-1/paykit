/**
 * PayPal PaymentProviderAdapter — Orders v2, intent CAPTURE.
 *
 * Endpoints (base https://api-m.paypal.com, sandbox https://api-m.sandbox.paypal.com):
 *   POST /v1/oauth2/token                          — client-credentials token
 *   POST /v2/checkout/orders                       — create order, payer approves on PayPal
 *   POST /v2/checkout/orders/{id}/capture          — move the money (on approval webhook)
 *   GET  /v2/checkout/orders/{id}, /v2/payments/captures/{id}, /v2/payments/refunds/{id}
 *                                                  — fetch-back webhook authentication
 *   POST /v2/payments/captures/{id}/refund         — refunds
 *   GET  /v1/reporting/transactions                — reconciliation (Transaction Search)
 *
 * Flow: createCheckout creates an order and returns its `payer-action` (or
 * `approve`) link. After the payer approves, CHECKOUT.ORDER.APPROVED arrives;
 * the adapter captures, and the capture result credits the payment. Nothing
 * is captured client-side, so a payer who closes the tab after approving is
 * still charged and credited — the webhook does the capture.
 *
 * Webhook authentication is fetch-back (see webhook-resolver.ts): the body is
 * an untrusted trigger and every state is re-read from PayPal's API. The sync
 * verify/parse pair is fail-closed so the sync path can never credit.
 *
 * providerRef round-trip: no providerSessionId is returned, so provider_ref =
 * transactionId. That value rides as the purchase unit's `custom_id`, which
 * PayPal copies onto the capture and into Transaction Search's
 * `custom_field`. The capture id arrives as providerPaymentId — the id the
 * refund API keys on.
 *
 * PayPal is not merchant of record and the order carries no tax breakdown,
 * so the captured amount equals the requested amount: exact-settling.
 *
 * NOT VERIFIED END-TO-END: no order has been created against a live or
 * sandbox PayPal account from this package. Paths, field names, statuses and
 * event types are taken from PayPal's published OpenAPI specs
 * (checkout_orders_v2, payments_payment_v2, notifications_webhooks_v1,
 * transaction search) and exercised only against a local mock. Items to
 * confirm on first live use: that `custom_id` reaches Transaction Search's
 * `custom_field` for Orders v2 captures, the actual refresh lag of
 * Transaction Search, and order approval-link expiry (3h is assumed).
 */
import {
  type CheckoutResult,
  type CreateCheckoutInput,
  type CurrencyCode,
  type NormalizedWebhookEvent,
  type PaymentProviderAdapter,
  type ProviderTxnRecord,
  type RefundInput,
  type RefundResult,
  UnsupportedCurrencyError,
} from "@xeko-git-1/paykit";
import { microsToPaypalValue } from "./amounts.js";
import { createPaypalClient, readPaypalError } from "./paypal-client.js";
import type { PaypalOrder } from "./paypal-types.js";
import { refundCapture } from "./refund.js";
import { searchSettledTransactions } from "./transaction-search.js";
import { createWebhookResolver } from "./webhook-resolver.js";

export interface PaypalAdapterConfig {
  readonly id?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Use https://api-m.sandbox.paypal.com when true. */
  readonly sandbox?: boolean;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  /** Shown on PayPal's approval page instead of the account's business name. */
  readonly brandName?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const PRODUCTION_BASE = "https://api-m.paypal.com";
const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
/**
 * PayPal documents no approval-link TTL in the order resource. 3h is a
 * paykit-side assumption, well inside the stale-checkout sweeper's default.
 */
const CHECKOUT_EXPIRY_MS = 3 * 60 * 60 * 1000;
const SUPPORTED: readonly CurrencyCode[] = ["USD", "EUR", "JPY"];

export function createPaypalAdapter(config: PaypalAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "paypal";
  const client = createPaypalClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    baseUrl: config.sandbox === true ? SANDBOX_BASE : PRODUCTION_BASE,
    fetcher: config.fetcher ?? fetch,
  });
  const resolve = createWebhookResolver(client);

  return {
    id,
    displayName: "PayPal",
    supportedCurrencies: SUPPORTED,
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (!SUPPORTED.includes(input.currencyCode)) {
        throw new UnsupportedCurrencyError(
          `PayPal adapter supports ${SUPPORTED.join("/")}; received '${input.currencyCode}'`,
        );
      }

      const experience: Record<string, unknown> = {
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
      };
      const returnUrl = input.returnUrl ?? config.returnUrl;
      if (returnUrl !== undefined) experience.return_url = returnUrl;
      const cancelUrl = config.cancelUrl ?? returnUrl;
      if (cancelUrl !== undefined) experience.cancel_url = cancelUrl;
      if (config.brandName !== undefined) experience.brand_name = config.brandName;

      const res = await client.request<PaypalOrder>("POST", "/v2/checkout/orders", {
        // A retried checkout for the same paykit transaction returns the same
        // order instead of opening a second one.
        requestId: `paykit-order-${input.transactionId}`,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              // custom_id is copied onto the capture and into Transaction
              // Search — the key every later event and listing matches on.
              custom_id: input.transactionId,
              description: (input.orderInfo ?? `Payment ${input.transactionId}`).slice(0, 127),
              amount: {
                currency_code: input.currencyCode,
                value: microsToPaypalValue(input.currencyCode, input.amountMicros),
              },
            },
          ],
          payment_source: { paypal: { experience_context: experience } },
        },
      });
      if (!res.ok || res.body === undefined) {
        throw new Error(
          `PayPal order creation failed: HTTP ${res.status} ${readPaypalError(res.text)}`,
        );
      }

      const links = res.body.links ?? [];
      const approveUrl =
        links.find((l) => l.rel === "payer-action")?.href ??
        links.find((l) => l.rel === "approve")?.href;
      if (typeof approveUrl !== "string" || approveUrl === "") {
        throw new Error("PayPal order creation returned no approval link");
      }

      // No providerSessionId: provider_ref stays = transactionId (custom_id).
      return {
        webUrl: approveUrl,
        expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_MS),
      };
    },

    // Fail-closed: authentication happens in resolveWebhook by fetch-back.
    verifyWebhookSignature(): boolean {
      return false;
    },

    parseWebhookPayload(): NormalizedWebhookEvent | null {
      return null;
    },

    resolveWebhook(rawBody: string): Promise<NormalizedWebhookEvent | null> {
      return resolve(rawBody);
    },

    refund(input: RefundInput): Promise<RefundResult> {
      return refundCapture(client, input);
    },

    fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      return searchSettledTransactions(client, window);
    },
  };
}
