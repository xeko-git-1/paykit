/**
 * Paddle Billing PaymentProviderAdapter — one-off transactions with inline
 * (non-catalog) prices. Paddle is the merchant of record: tax is computed,
 * collected, and remitted by Paddle.
 *
 * Endpoints (base https://api.paddle.com, sandbox https://sandbox-api.paddle.com):
 *   POST /transactions        — create a draft transaction with a checkout URL
 *   GET  /transactions        — list (billed_at-filtered) for reconciliation
 *   GET  /transactions/{id}   — line items for partial refunds
 *   POST /adjustments         — refunds (action=refund)
 *
 * Auth: `Authorization: Bearer <api key>`. The webhook secret is per
 * notification destination and separate from the API key.
 *
 * Checkout URL reality: `data.checkout.url` is the merchant's own approved
 * default payment link plus `?_ptxn=<transaction id>` — the page must embed
 * Paddle.js, which opens the checkout overlay for that transaction. Without an
 * approved default payment link Paddle rejects the create call
 * (transaction_default_checkout_url_not_set). This is unlike Stripe Checkout:
 * Paddle does not host the page.
 *
 * providerRef round-trip: createCheckout RETURNS the Paddle transaction id as
 * providerSessionId, so provider_ref = txn_... — exactly the `data.id` every
 * transaction webhook carries, and the id both the refund and the listing APIs
 * key on. custom_data still carries the paykit transaction id for audit.
 *
 * Refunds are ASYNC BY DESIGN: POST /adjustments answers `pending_approval` —
 * Paddle (as merchant of record) approves or rejects it later. The adapter
 * maps that to `pending_webhook`; `adjustment.updated` with status `approved`
 * settles the paykit row. A rejected adjustment produces no normalized event
 * (there is no refund-failed event type); the overdue-refund sweeper surfaces
 * the stuck row to an operator, which is the honest outcome for a
 * human-in-the-loop rejection.
 *
 * Zero-decimal currencies: every Paddle amount is a string in the currency's
 * smallest unit, so JPY "1000" is ¥1000 while USD "1000" is $10.00. The
 * conversion goes through the paykit currency registry's exponent, never a
 * hardcoded ×100.
 *
 * NOT VERIFIED END-TO-END: no transaction has been created against a live or
 * sandbox Paddle account from this package. Field names, the signature format,
 * event names, and pagination shape are taken from developer.paddle.com and
 * exercised here only against a local mock. Items to confirm on first live
 * use: draft-transaction TTL (undocumented — the 24h expiry below is a
 * paykit-side assumption), sandbox refund auto-approval, and the exact
 * `meta.pagination` field names.
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
  currencyExponent,
} from "@xeko-git-1/paykit";
import { verifyPaddleSignature } from "./webhook-verifier.js";

export const PAYKIT_REFERENCE_CUSTOM_DATA_KEY = "paykit_transaction_id";

export interface PaddleAdapterConfig {
  readonly id?: string;
  /** Paddle Billing API key (pdl_live_apikey_... / pdl_sdbx_apikey_...). */
  readonly apiKey: string;
  /**
   * Webhook endpoint secret key(s) (pdl_ntfset_...). An array survives
   * rotation without dropping in-flight deliveries.
   */
  readonly webhookSecret: string | readonly string[];
  /** Use https://sandbox-api.paddle.com when true. */
  readonly sandbox?: boolean;
  /**
   * Override checkout page URL (must be a Paddle-approved domain embedding
   * Paddle.js). Omitted → Paddle uses the account's default payment link.
   */
  readonly checkoutUrl?: string;
  /** Paddle tax category for the inline product. Default "standard". */
  readonly taxCategory?: string;
  /** Display name for the inline product on the checkout. */
  readonly productName?: string;
  /** Webhook timestamp tolerance in seconds. Default 300. */
  readonly webhookToleranceSeconds?: number;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const PRODUCTION_BASE = "https://api.paddle.com";
const SANDBOX_BASE = "https://sandbox-api.paddle.com";
/**
 * Paddle documents no TTL for a draft transaction's checkout link. 24h is a
 * paykit-side working assumption kept safely below the stale-checkout
 * sweeper's default (48h), so an abandoned draft is expired by paykit first.
 */
const CHECKOUT_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** GET /transactions caps per_page at 30 — lower than Paddle's other lists. */
const LIST_PAGE_SIZE = 30;
const MAX_LIST_PAGES = 200;

const SUPPORTED: readonly CurrencyCode[] = ["USD", "EUR", "JPY"];

interface PaddleTotals {
  readonly total?: string;
  readonly grand_total?: string;
  readonly currency_code?: string;
}

interface PaddleTransaction {
  readonly id?: string;
  readonly status?: string;
  readonly currency_code?: string;
  readonly custom_data?: Record<string, unknown> | null;
  readonly billed_at?: string | null;
  readonly details?: {
    readonly totals?: PaddleTotals;
    readonly line_items?: readonly { readonly id?: string }[];
  };
  readonly checkout?: { readonly url?: string | null };
}

interface PaddleAdjustment {
  readonly id?: string;
  readonly action?: string;
  readonly status?: string;
  readonly transaction_id?: string;
  readonly totals?: { readonly total?: string; readonly currency_code?: string };
}

interface PaddleEnvelope<T> {
  readonly data?: T;
  readonly error?: { readonly code?: string; readonly detail?: string };
  readonly meta?: {
    readonly pagination?: { readonly has_more?: boolean; readonly next?: string };
  };
}

/** Micros → minor-unit string per the registry exponent (JPY has no cents). */
function microsToMinorUnitString(currencyCode: CurrencyCode, micros: bigint): string {
  const divisor = currencyExponent(currencyCode) === 0 ? 1_000_000n : 10_000n;
  return (micros / divisor).toString();
}

/** Paddle minor-unit amount string → micros string. */
function minorUnitStringToMicros(currency: string, amount: string): string | null {
  if (!/^\d+$/.test(amount)) return null;
  const upper = currency.toUpperCase();
  const zeroDecimal = upper === "VND" || upper === "JPY" || upper === "KRW";
  const multiplier = zeroDecimal ? 1_000_000n : 10_000n;
  return (BigInt(amount) * multiplier).toString();
}

function readErrorDetail(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { code?: string; detail?: string } };
    const detail = json.error?.detail ?? json.error?.code;
    if (typeof detail === "string" && detail.length > 0) return detail;
  } catch {
    // fall through to the raw body
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

export function createPaddleAdapter(config: PaddleAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "paddle";
  const fetcher = config.fetcher ?? fetch;
  const base = config.sandbox === true ? SANDBOX_BASE : PRODUCTION_BASE;
  const secrets: readonly string[] = Array.isArray(config.webhookSecret)
    ? (config.webhookSecret as readonly string[])
    : [config.webhookSecret as string];
  const toleranceSeconds = config.webhookToleranceSeconds ?? 300;

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  }

  async function getTransaction(transactionId: string): Promise<PaddleTransaction> {
    const res = await fetcher(`${base}/transactions/${transactionId}`, {
      method: "GET",
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Paddle get transaction failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as PaddleEnvelope<PaddleTransaction>;
    if (json.data === undefined) throw new Error("Paddle get transaction returned no data");
    return json.data;
  }

  return {
    id,
    displayName: "Paddle",
    supportedCurrencies: SUPPORTED,
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (!SUPPORTED.includes(input.currencyCode)) {
        throw new UnsupportedCurrencyError(
          `Paddle adapter supports ${SUPPORTED.join("/")}; received '${input.currencyCode}'`,
        );
      }

      const body: Record<string, unknown> = {
        items: [
          {
            quantity: 1,
            // Non-catalog price AND product, both inline: nothing has to be
            // pre-created in Paddle's catalog for an arbitrary charge.
            price: {
              name: "Paykit charge",
              description: input.orderInfo ?? `Payment ${input.transactionId}`,
              unit_price: {
                amount: microsToMinorUnitString(input.currencyCode, input.amountMicros),
                currency_code: input.currencyCode,
              },
              product: {
                name: config.productName ?? "Account top-up",
                tax_category: config.taxCategory ?? "standard",
              },
            },
          },
        ],
        currency_code: input.currencyCode,
        custom_data: { [PAYKIT_REFERENCE_CUSTOM_DATA_KEY]: input.transactionId },
      };
      if (config.checkoutUrl !== undefined) {
        body.checkout = { url: config.checkoutUrl };
      }

      const res = await fetcher(`${base}/transactions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Paddle transaction creation failed: HTTP ${res.status} ${readErrorDetail(text)}`,
        );
      }

      const json = (await res.json()) as PaddleEnvelope<PaddleTransaction>;
      const txn = json.data;
      const checkoutUrl = txn?.checkout?.url;
      if (txn?.id === undefined || typeof checkoutUrl !== "string" || checkoutUrl === "") {
        throw new Error(
          "Paddle transaction creation returned no checkout url — is the default payment link configured and approved?",
        );
      }

      // provider_ref = the Paddle transaction id: it is data.id on every
      // transaction webhook and the key the refund and listing APIs use.
      return {
        webUrl: checkoutUrl,
        expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_MS),
        providerSessionId: txn.id,
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      return verifyPaddleSignature(rawBody, headers, secrets, { toleranceSeconds });
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let envelope: {
        event_id?: string;
        event_type?: string;
        data?: Record<string, unknown>;
      };
      try {
        envelope = JSON.parse(rawBody) as typeof envelope;
      } catch {
        return null;
      }
      const eventType = envelope.event_type;
      const data = envelope.data;
      if (typeof eventType !== "string" || data === undefined) return null;
      const eventId = envelope.event_id ?? `paddle:${eventType}:${String(data.id ?? "unknown")}`;

      // `transaction.completed` (~1s after `paid`) is the fulfillment event;
      // crediting on `paid` too would double-see every payment.
      if (eventType === "transaction.completed") {
        const txn = data as PaddleTransaction;
        if (typeof txn.id !== "string" || txn.status !== "completed") return null;
        const totals = txn.details?.totals;
        const amount = totals?.grand_total ?? totals?.total;
        const currency = (txn.currency_code ?? totals?.currency_code ?? "USD").toUpperCase();
        if (typeof amount !== "string") return null;
        const amountMicros = minorUnitStringToMicros(currency, amount);
        if (amountMicros === null) return null;
        return {
          eventId,
          type: "payment.completed",
          providerRef: txn.id,
          amountMicros,
          currencyCode: currency,
          metadata: {
            ...(txn.custom_data !== null && txn.custom_data !== undefined
              ? { customData: txn.custom_data }
              : {}),
          },
        };
      }

      if (eventType === "transaction.payment_failed" || eventType === "transaction.canceled") {
        const txn = data as PaddleTransaction;
        if (typeof txn.id !== "string") return null;
        return {
          eventId,
          type: "payment.failed",
          providerRef: txn.id,
          metadata: {},
        };
      }

      if (eventType === "transaction.past_due") return null;

      if (eventType === "adjustment.updated" || eventType === "adjustment.created") {
        const adj = data as PaddleAdjustment;
        if (adj.action !== "refund") return null;
        // Only APPROVED moves money. pending_approval is the initial state
        // (audit noise here), and a REJECTED refund maps to no event type —
        // the stuck pending_webhook row is surfaced by the overdue-refund
        // sweeper for an operator, because a merchant-of-record rejection is
        // a human decision, not a wire outcome.
        if (adj.status !== "approved") return null;
        if (typeof adj.id !== "string" || typeof adj.transaction_id !== "string") return null;
        const total = adj.totals?.total;
        const currency = (adj.totals?.currency_code ?? "USD").toUpperCase();
        if (typeof total !== "string") return null;
        const refundMicros = minorUnitStringToMicros(currency, total);
        if (refundMicros === null) return null;
        return {
          eventId,
          type: "payment.refunded",
          providerRef: adj.transaction_id,
          refundAmountMicros: refundMicros,
          currencyCode: currency,
          providerRefundId: adj.id,
          metadata: {},
        };
      }

      return null;
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      if (input.providerRef === undefined || input.providerRef === "") {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_TRANSACTION_ID",
            message: "no Paddle transaction id on the payment row",
          },
        };
      }

      // Full vs partial is decided against the transaction's own grand total,
      // fetched fresh: a full refund needs no item breakdown, a partial one
      // must name the line item it draws from.
      let body: Record<string, unknown>;
      try {
        const txn = await getTransaction(input.providerRef);
        const totals = txn.details?.totals;
        const grandTotal = totals?.grand_total ?? totals?.total;
        const currency = (txn.currency_code ?? "USD").toUpperCase();
        const grandTotalMicros =
          typeof grandTotal === "string" ? minorUnitStringToMicros(currency, grandTotal) : null;

        if (grandTotalMicros !== null && BigInt(grandTotalMicros) === input.amountMicros) {
          body = {
            action: "refund",
            type: "full",
            transaction_id: input.providerRef,
            reason: input.reason.slice(0, 500),
          };
        } else {
          const lineItemId = txn.details?.line_items?.[0]?.id;
          if (typeof lineItemId !== "string") {
            return {
              state: "failed",
              error: {
                providerCode: "MISSING_LINE_ITEM",
                message: "Paddle transaction has no line items to draw a partial refund from",
              },
            };
          }
          const exponent = currencyExponent(
            (SUPPORTED.find((c) => c === currency) ?? "USD") as CurrencyCode,
          );
          const divisor = exponent === 0 ? 1_000_000n : 10_000n;
          body = {
            action: "refund",
            type: "partial",
            transaction_id: input.providerRef,
            reason: input.reason.slice(0, 500),
            items: [
              {
                item_id: lineItemId,
                type: "partial",
                amount: (input.amountMicros / divisor).toString(),
              },
            ],
          };
        }
      } catch (err) {
        return {
          state: "failed",
          error: {
            providerCode: "TRANSACTION_LOOKUP_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      const res = await fetcher(`${base}/adjustments`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          state: "failed",
          error: {
            providerCode: `HTTP_${res.status}`,
            message: `Paddle adjustment failed: ${readErrorDetail(text)}`,
          },
        };
      }

      const json = (await res.json()) as PaddleEnvelope<PaddleAdjustment>;
      const adj = json.data;
      if (adj?.status === "approved" && typeof adj.id === "string") {
        return { state: "completed", providerRefundId: adj.id };
      }
      // pending_approval is the DOCUMENTED response: Paddle, as merchant of
      // record, approves refunds out-of-band. The adjustment.updated webhook
      // settles the paykit row either way.
      return {
        state: "pending_webhook",
        ...(typeof adj?.id === "string" ? { providerRefundId: adj.id } : {}),
      };
    },

    /**
     * Every completed transaction billed in [since, until), following
     * `meta.pagination.next` to the end. Filtering is server-side
     * (billed_at[GTE]/[LT] + status=completed), so unlike the Polar/Coinbase
     * listings nothing here depends on client-side window trimming.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const until = window.until ?? new Date();
      const records: ProviderTxnRecord[] = [];

      const params = new URLSearchParams({
        status: "completed",
        per_page: String(LIST_PAGE_SIZE),
        "billed_at[GTE]": window.since.toISOString(),
        "billed_at[LT]": until.toISOString(),
      });
      let url = `${base}/transactions?${params.toString()}`;
      let pages = 0;

      while (pages < MAX_LIST_PAGES) {
        const res = await fetcher(url, { method: "GET", headers: authHeaders() });
        if (!res.ok) {
          throw new Error(`Paddle list transactions failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as PaddleEnvelope<readonly PaddleTransaction[]>;
        const page = json.data ?? [];

        for (const txn of page) {
          if (typeof txn.id !== "string") continue;
          const totals = txn.details?.totals;
          const amount = totals?.grand_total ?? totals?.total;
          if (typeof amount !== "string") continue;
          const currency = (txn.currency_code ?? totals?.currency_code ?? "USD").toUpperCase();
          const amountMicros = minorUnitStringToMicros(currency, amount);
          if (amountMicros === null) continue;
          records.push({ providerRef: txn.id, amountMicros, currencyCode: currency });
        }

        pages += 1;
        const pagination = json.meta?.pagination;
        if (pagination?.has_more !== true || typeof pagination.next !== "string") break;
        url = pagination.next;
      }

      if (pages >= MAX_LIST_PAGES) {
        throw new Error(
          `Paddle list transactions exceeded ${MAX_LIST_PAGES} pages; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
