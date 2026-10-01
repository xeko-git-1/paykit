/**
 * Polar PaymentProviderAdapter — fixed-price one-off checkouts over a Polar
 * product.
 *
 * Endpoints (base https://api.polar.sh/v1, sandbox https://sandbox-api.polar.sh/v1;
 * note the trailing slashes — Polar redirects without them):
 *   POST /checkouts/  — create a checkout session (hosted page)
 *   POST /refunds/    — refund an order, full or partial
 *   GET  /orders/     — list orders, page/limit-paginated (reconciliation)
 *
 * Auth: `Authorization: Bearer <organization access token>`. The webhook secret
 * is separate and configured per endpoint in Polar's dashboard.
 *
 * Product requirement: Polar has no amount-only checkout — every session names
 * at least one product. The adapter takes ONE `productId` and overrides its
 * price per session with a `fixed` ad-hoc amount, which is how an arbitrary
 * paykit charge rides on a single pre-created "top-up" product.
 *
 * providerRef round-trip: createCheckout does NOT return providerSessionId, so
 * the server stores provider_ref = transactionId. That value travels in the
 * checkout's `metadata.paykit_transaction_id`, which Polar copies onto the
 * resulting order and echoes on every order webhook, so the router's
 * (provider, provider_ref) lookup matches. The Polar order id arrives on
 * `order.paid` as `providerPaymentId` — the id the refund API needs.
 *
 * Refunds: POST /refunds/ answers 201 with a status that may still be
 * `pending`; `succeeded` maps to completed, `pending` to pending_webhook
 * (settled later by the `refund.updated` webhook). API-created refunds carry
 * the paykit transaction id in their metadata; a refund made from Polar's
 * dashboard has no such key and its webhook is skipped — the operator already
 * acted deliberately outside paykit and owns the ledger adjustment.
 *
 * NOT VERIFIED END-TO-END: no checkout has been created against a live or
 * sandbox Polar account from this package. Field names, event types, the
 * Standard Webhooks secret encoding, and the orders listing shape are taken
 * from Polar's published OpenAPI spec (version 2026-04) and official SDK and
 * are exercised here only against a local mock. Items to confirm on first live
 * use: that checkout metadata is copied onto orders verbatim, the `order.paid`
 * payload's `total_amount` semantics under discounts/tax, and the absence of a
 * created-at range filter on GET /orders/.
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
  currencyExponent,
} from "@xeko-git-1/paykit";
import { verifyPolarSignature } from "./webhook-verifier.js";

export const PAYKIT_REFERENCE_METADATA_KEY = "paykit_transaction_id";

export interface PolarAdapterConfig {
  readonly id?: string;
  /** Organization access token (polar_oat_...). */
  readonly accessToken: string;
  /** The pre-created Polar product every paykit charge is priced over. */
  readonly productId: string;
  /**
   * Webhook secret(s) as shown in Polar's dashboard (raw string, no whsec_
   * prefix). An array survives rotation without dropping in-flight deliveries.
   */
  readonly webhookSecret: string | readonly string[];
  /** Use https://sandbox-api.polar.sh when true. */
  readonly sandbox?: boolean;
  readonly successUrl?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const PRODUCTION_BASE = "https://api.polar.sh/v1";
const SANDBOX_BASE = "https://sandbox-api.polar.sh/v1";
const CHECKOUT_EXPIRY_FALLBACK_MS = 60 * 60 * 1000;
const LIST_PAGE_LIMIT = 100;
/** Bounds one reconciliation run if the pagination never terminates. */
const MAX_LIST_PAGES = 50;

interface PolarOrder {
  readonly id?: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly total_amount?: number;
  readonly refunded_amount?: number;
  readonly currency?: string;
  readonly created_at?: string;
  readonly checkout_id?: string;
  readonly metadata?: Record<string, unknown>;
}

interface PolarRefund {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly order_id?: string;
  readonly metadata?: Record<string, unknown>;
}

interface PolarWebhookEnvelope {
  readonly type?: string;
  readonly data?: Record<string, unknown>;
}

/** Micros → the currency's minor units, truncating sub-minor-unit surplus. */
function microsToMinorUnits(
  currencyCode: CreateCheckoutInput["currencyCode"],
  micros: bigint,
): number {
  const exponent = currencyExponent(currencyCode);
  const divisor = exponent === 0 ? 1_000_000n : 10_000n;
  return Number(micros / divisor);
}

/** Minor units (integer) → micros string, per the currency's exponent. */
function minorUnitsToMicrosString(currency: string, minorUnits: number): string {
  const upper = currency.toUpperCase();
  const zeroDecimal = upper === "VND" || upper === "JPY" || upper === "KRW";
  const multiplier = zeroDecimal ? 1_000_000n : 10_000n;
  return (BigInt(Math.round(minorUnits)) * multiplier).toString();
}

function readErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { detail?: unknown; error?: unknown };
    if (typeof json.error === "string") return json.error;
    if (typeof json.detail === "string") return json.detail;
  } catch {
    // fall through to the raw body
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

export function createPolarAdapter(config: PolarAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "polar";
  const fetcher = config.fetcher ?? fetch;
  const base = config.sandbox === true ? SANDBOX_BASE : PRODUCTION_BASE;
  const secrets: readonly string[] = Array.isArray(config.webhookSecret)
    ? (config.webhookSecret as readonly string[])
    : [config.webhookSecret as string];

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.accessToken}`,
    };
  }

  return {
    id,
    displayName: "Polar",
    supportedCurrencies: ["USD", "EUR"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD" && input.currencyCode !== "EUR") {
        throw new UnsupportedCurrencyError(
          `Polar adapter supports USD/EUR; received '${input.currencyCode}'`,
        );
      }

      const body: Record<string, unknown> = {
        products: [config.productId],
        // The ad-hoc price: overrides the product's catalog price for this
        // session only. `price_amount` is in the currency's minor units.
        prices: {
          [config.productId]: [
            {
              amount_type: "fixed",
              price_amount: microsToMinorUnits(input.currencyCode, input.amountMicros),
              price_currency: input.currencyCode.toLowerCase(),
            },
          ],
        },
        // Copied by Polar onto the resulting order and echoed on every order
        // webhook — the only key that ties an event back to a paykit row.
        metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: input.transactionId },
      };
      const successUrl = input.returnUrl ?? config.successUrl;
      if (successUrl !== undefined) body.success_url = successUrl;
      if (input.customerEmail !== undefined) body.customer_email = input.customerEmail;

      const res = await fetcher(`${base}/checkouts/`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Polar checkout creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }

      const checkout = (await res.json()) as { url?: string; expires_at?: string };
      if (typeof checkout.url !== "string" || checkout.url === "") {
        throw new Error("Polar checkout creation returned no url");
      }

      // No providerSessionId: provider_ref stays = transactionId, which is what
      // order webhooks carry back in metadata. Returning Polar's checkout id
      // here would leave inbound order events matching no row.
      return {
        webUrl: checkout.url,
        expiresAt:
          typeof checkout.expires_at === "string" && !Number.isNaN(Date.parse(checkout.expires_at))
            ? new Date(checkout.expires_at)
            : new Date(Date.now() + CHECKOUT_EXPIRY_FALLBACK_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      return verifyPolarSignature(rawBody, headers, secrets);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let envelope: PolarWebhookEnvelope;
      try {
        envelope = JSON.parse(rawBody) as PolarWebhookEnvelope;
      } catch {
        // Null rather than a throw: an unparseable body is acknowledged and
        // dropped, where a throw would invite redelivery of something that
        // will never parse.
        return null;
      }
      const type = envelope.type;
      const data = envelope.data;
      if (typeof type !== "string" || data === undefined) return null;

      if (type === "order.paid") {
        const order = data as PolarOrder;
        const reference = order.metadata?.[PAYKIT_REFERENCE_METADATA_KEY];
        if (typeof reference !== "string" || reference === "") return null;
        if (typeof order.total_amount !== "number" || typeof order.id !== "string") return null;
        const currency = (order.currency ?? "usd").toUpperCase();
        return {
          eventId: `polar:order.paid:${order.id}`,
          type: "payment.completed",
          providerRef: reference,
          amountMicros: minorUnitsToMicrosString(currency, order.total_amount),
          currencyCode: currency,
          // The refund API keys on the ORDER id, which only exists once paid.
          providerPaymentId: order.id,
          metadata: {
            polarOrderId: order.id,
            ...(order.checkout_id !== undefined ? { polarCheckoutId: order.checkout_id } : {}),
          },
        };
      }

      if (type === "refund.updated" || type === "refund.created") {
        const refund = data as PolarRefund;
        // Only a SUCCEEDED refund moves money; pending/failed/canceled updates
        // are audit noise here (the pending_webhook row waits for succeeded).
        if (refund.status !== "succeeded") return null;
        const reference = refund.metadata?.[PAYKIT_REFERENCE_METADATA_KEY];
        // A dashboard-made refund carries no paykit key: the operator acted
        // outside paykit deliberately and owns the ledger adjustment.
        if (typeof reference !== "string" || reference === "") return null;
        if (typeof refund.id !== "string" || typeof refund.amount !== "number") return null;
        const currency = (refund.currency ?? "usd").toUpperCase();
        return {
          eventId: `polar:refund:${refund.id}`,
          type: "payment.refunded",
          providerRef: reference,
          refundAmountMicros: minorUnitsToMicrosString(currency, refund.amount),
          currencyCode: currency,
          providerRefundId: refund.id,
          metadata: {
            ...(refund.order_id !== undefined ? { polarOrderId: refund.order_id } : {}),
          },
        };
      }

      if (type === "checkout.updated") {
        const checkout = data as { status?: string; metadata?: Record<string, unknown> };
        if (checkout.status !== "expired" && checkout.status !== "failed") return null;
        const reference = checkout.metadata?.[PAYKIT_REFERENCE_METADATA_KEY];
        if (typeof reference !== "string" || reference === "") return null;
        return {
          eventId: `polar:checkout.${checkout.status}:${reference}`,
          type: checkout.status === "expired" ? "payment.expired" : "payment.failed",
          providerRef: reference,
          metadata: {},
        };
      }

      return null;
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      // input.providerRef is providerPaymentId ?? providerRef from the payment
      // row — for Polar that is the order id captured on order.paid. Without
      // it there is nothing to refund against.
      if (input.providerRef === undefined || input.providerRef === "") {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_ORDER_ID",
            message:
              "no Polar order id on the payment row — the order.paid webhook has not been processed",
          },
        };
      }

      const res = await fetcher(`${base}/refunds/`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          order_id: input.providerRef,
          reason: "customer_request",
          amount: Number(input.amountMicros / 10_000n),
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: input.transactionId },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          state: "failed",
          error: {
            providerCode: `HTTP_${res.status}`,
            message: `Polar refund failed: ${readErrorMessage(text)}`,
          },
        };
      }

      const refund = (await res.json()) as PolarRefund;
      if (refund.status === "succeeded" && typeof refund.id === "string") {
        return { state: "completed", providerRefundId: refund.id };
      }
      if (refund.status === "pending") {
        // The processor has not finished; the refund.updated webhook settles it.
        return {
          state: "pending_webhook",
          ...(typeof refund.id === "string" ? { providerRefundId: refund.id } : {}),
        };
      }
      return {
        state: "failed",
        error: {
          providerCode: refund.status ?? "UNKNOWN",
          message: `Polar refund returned status '${refund.status ?? "missing"}'`,
        },
      };
    },

    /**
     * Every paid order in the window. GET /orders/ has no created-at range
     * filter, so the window is applied here: pages are walked newest-first
     * (sorting=-created_at) and the walk stops once a whole page predates
     * `since`. Records are keyed on paykit's own reference from order
     * metadata; an order created outside paykit has no such key and is
     * skipped rather than reported as an unknown payment.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const since = window.since.getTime();
      const until = (window.until ?? new Date()).getTime();

      const records: ProviderTxnRecord[] = [];
      let page = 1;

      while (page <= MAX_LIST_PAGES) {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(LIST_PAGE_LIMIT),
          sorting: "-created_at",
        });
        const res = await fetcher(`${base}/orders/?${params.toString()}`, {
          method: "GET",
          headers: authHeaders(),
        });
        if (!res.ok) {
          throw new Error(`Polar list orders failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          items?: readonly PolarOrder[];
          pagination?: { max_page?: number };
        };
        const items = json.items ?? [];

        for (const order of items) {
          if (order.paid !== true) continue;
          const reference = order.metadata?.[PAYKIT_REFERENCE_METADATA_KEY];
          if (typeof reference !== "string" || reference === "") continue;
          if (typeof order.created_at !== "string") continue;
          const createdAt = Date.parse(order.created_at);
          if (Number.isNaN(createdAt) || createdAt < since || createdAt >= until) continue;
          if (typeof order.total_amount !== "number") continue;
          const currency = (order.currency ?? "usd").toUpperCase();
          records.push({
            providerRef: reference,
            amountMicros: minorUnitsToMicrosString(currency, order.total_amount),
            currencyCode: currency,
            ...(typeof order.refunded_amount === "number" && order.refunded_amount > 0
              ? { refundedAmountMicros: minorUnitsToMicrosString(currency, order.refunded_amount) }
              : {}),
          });
        }

        // Newest first: once a whole page predates the window, older pages
        // cannot contain anything in it.
        const newestBeforeWindow =
          items.length > 0 &&
          items.every((order) => {
            const createdAt = Date.parse(order.created_at ?? "");
            return !Number.isNaN(createdAt) && createdAt < since;
          });
        if (newestBeforeWindow) break;

        const maxPage = json.pagination?.max_page ?? page;
        if (items.length < LIST_PAGE_LIMIT || page >= maxPage) break;
        page += 1;
      }

      if (page > MAX_LIST_PAGES) {
        // Returning quietly would present a truncated list as complete, and the
        // reconciler would report every order past the ceiling as missing.
        throw new Error(
          `Polar list orders exceeded ${MAX_LIST_PAGES} pages; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
