/**
 * Creem.io PaymentProviderAdapter — checkout sessions over a pre-created
 * product, with licensing metadata pass-through.
 *
 * Endpoints (base https://api.creem.io, test mode https://test-api.creem.io):
 *   POST /v1/checkouts            — create a checkout session (hosted page)
 *   GET  /v1/transactions/search  — list transactions (reconciliation)
 *
 * Auth: `x-api-key: <api key>`. The webhook secret is separate, from the
 * dashboard's webhook settings.
 *
 * Product requirement: like Polar, Creem has no product-less checkout — every
 * session names a product. The adapter takes ONE `productId` and, when the
 * paykit amount differs from the catalog price, overrides it per session with
 * `custom_price` (minor units).
 *
 * providerRef round-trip: createCheckout returns the Creem checkout id
 * (ch_...) as providerSessionId, so provider_ref = the checkout id — exactly
 * the `object.id` the checkout.completed webhook carries. `request_id` and
 * `metadata.paykit_transaction_id` both carry the paykit transaction id for
 * audit and as a secondary match key.
 *
 * Refunds are DASHBOARD-ONLY on Creem's side (no public refund API), so
 * `refund()` answers `unsupported` — same posture as SePay — and the operator
 * refunds in Creem's dashboard. The resulting `refund.created` webhook then
 * credits the paykit ledger, keyed on the refunded checkout's id.
 *
 * Licensing: Creem can issue license keys per product. The adapter does not
 * manage licenses, but checkout.completed forwards `license` (when present)
 * inside event metadata so the consumer can persist/deliver the key.
 *
 * NOT VERIFIED END-TO-END: no checkout has been created against a live or
 * test-mode Creem account from this package. Field names, the signature
 * format, event names, and the transactions-search shape are taken from
 * docs.creem.io and exercised here only against a local mock. Items to
 * confirm on first live use: `custom_price` acceptance on POST /v1/checkouts,
 * checkout-session TTL (none documented — the 1h expiry below is a paykit-side
 * assumption), and the transactions-search response field names.
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
import { verifyCreemSignature } from "./webhook-verifier.js";

export const PAYKIT_REFERENCE_METADATA_KEY = "paykit_transaction_id";

export interface CreemAdapterConfig {
  readonly id?: string;
  /** Creem API key (creem_...). */
  readonly apiKey: string;
  /** The pre-created Creem product every paykit charge is priced over. */
  readonly productId: string;
  /**
   * Webhook secret(s) (whsec_...) from the dashboard. An array survives
   * rotation without dropping in-flight deliveries.
   */
  readonly webhookSecret: string | readonly string[];
  /** Use https://test-api.creem.io when true. */
  readonly testMode?: boolean;
  readonly successUrl?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const PRODUCTION_BASE = "https://api.creem.io";
const TEST_BASE = "https://test-api.creem.io";
/**
 * Creem documents no expiry for a checkout session. 1h is a paykit-side
 * working assumption — well inside the stale-checkout sweeper's default TTL.
 */
const CHECKOUT_EXPIRY_FALLBACK_MS = 60 * 60 * 1000;
const LIST_PAGE_SIZE = 100;
/** Bounds one reconciliation run if the pagination never terminates. */
const MAX_LIST_PAGES = 50;

const SUPPORTED = ["USD", "EUR"] as const;

interface CreemOrder {
  readonly id?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly status?: string;
}

interface CreemCheckoutObject {
  readonly id?: string;
  readonly status?: string;
  readonly request_id?: string | null;
  readonly order?: CreemOrder | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly license?: Record<string, unknown> | null;
}

interface CreemRefundObject {
  readonly id?: string;
  readonly status?: string;
  readonly refund_amount?: number;
  readonly amount?: number;
  readonly currency?: string;
  readonly refund_currency?: string;
  readonly checkout?: CreemCheckoutObject | string | null;
  readonly order?: CreemOrder | string | null;
}

interface CreemTransaction {
  readonly id?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly created_at?: number | string;
  readonly checkout_id?: string | null;
  readonly order?: CreemOrder | string | null;
}

/** Minor units (integer) → micros string, per the currency's exponent. */
function minorUnitsToMicrosString(currency: string, minorUnits: number): string {
  const upper = currency.toUpperCase();
  const zeroDecimal = upper === "VND" || upper === "JPY" || upper === "KRW";
  const multiplier = zeroDecimal ? 1_000_000n : 10_000n;
  return (BigInt(Math.round(minorUnits)) * multiplier).toString();
}

function parseCreatedAt(value: number | string | undefined): number {
  if (typeof value === "number") {
    // Epoch seconds vs milliseconds: anything below 1e12 is seconds.
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function readErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof json.message === "string") return json.message;
    if (typeof json.error === "string") return json.error;
  } catch {
    // fall through to the raw body
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

export function createCreemAdapter(config: CreemAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "creem";
  const fetcher = config.fetcher ?? fetch;
  const base = config.testMode === true ? TEST_BASE : PRODUCTION_BASE;
  const secrets: readonly string[] = Array.isArray(config.webhookSecret)
    ? (config.webhookSecret as readonly string[])
    : [config.webhookSecret as string];

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    };
  }

  return {
    id,
    displayName: "Creem",
    supportedCurrencies: [...SUPPORTED],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (!(SUPPORTED as readonly string[]).includes(input.currencyCode)) {
        throw new UnsupportedCurrencyError(
          `Creem adapter supports ${SUPPORTED.join("/")}; received '${input.currencyCode}'`,
        );
      }

      const divisor = currencyExponent(input.currencyCode) === 0 ? 1_000_000n : 10_000n;
      const body: Record<string, unknown> = {
        product_id: config.productId,
        // Echoed back on checkout.completed — a secondary match key besides
        // metadata, and what ties dashboard rows to paykit rows for a human.
        request_id: input.transactionId,
        units: 1,
        // Per-session price override in minor units, so one pre-created
        // product carries arbitrary paykit amounts.
        custom_price: Number(input.amountMicros / divisor),
        metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: input.transactionId },
      };
      const successUrl = input.returnUrl ?? config.successUrl;
      if (successUrl !== undefined) body.success_url = successUrl;
      if (input.customerEmail !== undefined) {
        body.customer = { email: input.customerEmail };
      }

      const res = await fetcher(`${base}/v1/checkouts`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Creem checkout creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }

      const checkout = (await res.json()) as { id?: string; checkout_url?: string };
      if (typeof checkout.checkout_url !== "string" || checkout.checkout_url === "") {
        throw new Error("Creem checkout creation returned no checkout_url");
      }
      if (typeof checkout.id !== "string" || checkout.id === "") {
        throw new Error("Creem checkout creation returned no id");
      }

      // provider_ref = the Creem checkout id: it is object.id on
      // checkout.completed, and the key a dashboard refund's webhook points
      // back at.
      return {
        webUrl: checkout.checkout_url,
        expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_FALLBACK_MS),
        providerSessionId: checkout.id,
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      return verifyCreemSignature(rawBody, headers, secrets);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let envelope: {
        id?: string;
        eventType?: string;
        event_type?: string;
        object?: Record<string, unknown>;
      };
      try {
        envelope = JSON.parse(rawBody) as typeof envelope;
      } catch {
        return null;
      }
      // Creem's docs show camelCase `eventType`; tolerate snake_case too.
      const eventType = envelope.eventType ?? envelope.event_type;
      const object = envelope.object;
      if (typeof eventType !== "string" || object === undefined) return null;

      if (eventType === "checkout.completed") {
        const checkout = object as CreemCheckoutObject;
        if (typeof checkout.id !== "string" || checkout.id === "") return null;
        const order = checkout.order;
        if (order === null || order === undefined || typeof order.amount !== "number") return null;
        // A completed checkout whose order is not paid credits nothing.
        if (order.status !== undefined && order.status !== "paid") return null;
        const currency = (order.currency ?? "USD").toUpperCase();
        return {
          eventId: envelope.id ?? `creem:checkout.completed:${checkout.id}`,
          type: "payment.completed",
          providerRef: checkout.id,
          amountMicros: minorUnitsToMicrosString(currency, order.amount),
          currencyCode: currency,
          ...(typeof order.id === "string" ? { providerPaymentId: order.id } : {}),
          metadata: {
            ...(checkout.request_id !== null && checkout.request_id !== undefined
              ? { requestId: checkout.request_id }
              : {}),
            // Licensing pass-through: the consumer persists/delivers the key;
            // paykit only ferries it.
            ...(checkout.license !== null && checkout.license !== undefined
              ? { license: checkout.license }
              : {}),
            ...(checkout.metadata !== null && checkout.metadata !== undefined
              ? { checkoutMetadata: checkout.metadata }
              : {}),
          },
        };
      }

      if (eventType === "refund.created") {
        const refund = object as CreemRefundObject;
        if (typeof refund.id !== "string" || refund.id === "") return null;
        // The refunded checkout's id is the (provider, provider_ref) key.
        const checkout = refund.checkout;
        const checkoutId = typeof checkout === "string" ? checkout : (checkout?.id ?? undefined);
        if (typeof checkoutId !== "string" || checkoutId === "") return null;
        const amount = refund.refund_amount ?? refund.amount;
        if (typeof amount !== "number") return null;
        const currency = (refund.refund_currency ?? refund.currency ?? "USD").toUpperCase();
        return {
          eventId: envelope.id ?? `creem:refund.created:${refund.id}`,
          type: "payment.refunded",
          providerRef: checkoutId,
          refundAmountMicros: minorUnitsToMicrosString(currency, amount),
          currencyCode: currency,
          providerRefundId: refund.id,
          metadata: {},
        };
      }

      if (eventType === "checkout.expired") {
        const checkout = object as CreemCheckoutObject;
        if (typeof checkout.id !== "string" || checkout.id === "") return null;
        return {
          eventId: envelope.id ?? `creem:checkout.expired:${checkout.id}`,
          type: "payment.expired",
          providerRef: checkout.id,
          metadata: {},
        };
      }

      return null;
    },

    async refund(_input: RefundInput): Promise<RefundResult> {
      // Creem exposes no public refund API — refunds are made in the Creem
      // dashboard. Same posture as SePay: the adapter says so instead of
      // faking an API, and the dashboard refund's webhook credits the ledger.
      return {
        state: "unsupported",
        error: {
          providerCode: "DASHBOARD_ONLY",
          message:
            "Creem refunds are dashboard-only; refund in the Creem dashboard and the refund.created webhook will settle the paykit row",
        },
      };
    },

    /**
     * Every completed transaction in the window. /v1/transactions/search has
     * no date-range parameters, so the window is applied client-side while
     * walking pages — same posture as the Polar orders listing. Records are
     * keyed on checkout_id (= provider_ref); rows without one predate paykit
     * or belong to other tooling and are skipped.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const since = window.since.getTime();
      const until = (window.until ?? new Date()).getTime();

      const records: ProviderTxnRecord[] = [];
      let pageNumber = 1;

      while (pageNumber <= MAX_LIST_PAGES) {
        const params = new URLSearchParams({
          page_number: String(pageNumber),
          page_size: String(LIST_PAGE_SIZE),
        });
        const res = await fetcher(`${base}/v1/transactions/search?${params.toString()}`, {
          method: "GET",
          headers: authHeaders(),
        });
        if (!res.ok) {
          throw new Error(`Creem list transactions failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          items?: readonly CreemTransaction[];
          pagination?: { total_pages?: number };
        };
        const items = json.items ?? [];

        for (const txn of items) {
          if (txn.status !== undefined && txn.status !== "paid" && txn.status !== "completed") {
            continue;
          }
          const checkoutId = txn.checkout_id;
          if (typeof checkoutId !== "string" || checkoutId === "") continue;
          const createdAt = parseCreatedAt(txn.created_at);
          if (Number.isNaN(createdAt) || createdAt < since || createdAt >= until) continue;
          if (typeof txn.amount !== "number") continue;
          const currency = (txn.currency ?? "USD").toUpperCase();
          records.push({
            providerRef: checkoutId,
            amountMicros: minorUnitsToMicrosString(currency, txn.amount),
            currencyCode: currency,
          });
        }

        const totalPages = json.pagination?.total_pages ?? pageNumber;
        if (items.length < LIST_PAGE_SIZE || pageNumber >= totalPages) break;
        pageNumber += 1;
      }

      if (pageNumber > MAX_LIST_PAGES) {
        throw new Error(
          `Creem list transactions exceeded ${MAX_LIST_PAGES} pages; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
