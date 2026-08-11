/**
 * Coinbase Commerce PaymentProviderAdapter — USD-priced crypto charges.
 *
 * Endpoints (base https://api.commerce.coinbase.com):
 *   POST /charges   — create a charge (hosted checkout page)
 *   GET  /charges   — list charges, cursor-paginated (reconciliation)
 *
 * Auth: `X-CC-Api-Key` plus `X-CC-Version` on every REST call. The webhook shared
 * secret is separate from the API key.
 *
 * NO REFUND API. Coinbase Commerce exposes create and read on charges and nothing
 * else — its own SDKs declare exactly those two operations. Refunds are performed
 * out-of-band from the merchant's Coinbase account, so `refund` returns
 * `unsupported` and the server answers 501, pointing an operator at the ledger
 * adjustment route. This is a property of the provider, not a gap in this adapter:
 * returning `failed` would suggest a rejected request that was never made, and
 * `pending_webhook` would strand the transaction waiting for an event that cannot
 * arrive.
 *
 * Currency: paykit prices in USD (`pricing_type: fixed_price` with a USD
 * `local_price`). The customer picks the coin and chain on Coinbase's page; the
 * payer's asset is invisible to the paykit ledger, which only ever sees USD.
 *
 * providerRef round-trip: createCheckout does NOT return providerSessionId, so the
 * server stores provider_ref = transactionId. That value is carried in the
 * charge's `metadata.paykit_transaction_id`, which Coinbase echoes on every
 * webhook event, so the router's (provider, provider_ref) lookup matches. Coinbase's
 * own `id`/`code` are its identifiers and travel in metadata only — returning
 * either as providerSessionId would leave inbound webhooks matching no row, and
 * the customer's payment would never be credited.
 *
 * NOT VERIFIED END-TO-END: no charge has been created against a live or sandbox
 * Coinbase Commerce account from this package. The signature scheme, auth headers,
 * base URL, API version, charge-create body, and list pagination are taken from
 * Coinbase's published SDKs and are exercised here only against a local mock.
 * Items to confirm on first live use: the `charge:delayed` / `charge:resolved`
 * event names, that `pricing.local` is present on webhook charges (not just
 * `local_price`), the timeline `context` spelling for UNDERPAID, and that
 * `payments[].value.local` carries the USD equivalent rather than the crypto
 * amount.
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
} from "@xeko-git-1/paykit";
import {
  type CoinbaseCommerceCharge,
  type CoinbaseCommerceEventEnvelope,
  PAYKIT_REFERENCE_METADATA_KEY,
  parseCoinbaseCommerceEvent,
} from "./webhook-events.js";
import { verifyCoinbaseCommerceSignature } from "./webhook-verifier.js";

export interface CoinbaseCommerceAdapterConfig {
  readonly id?: string;
  /** Commerce API key — sent as X-CC-Api-Key. */
  readonly apiKey: string;
  /**
   * Webhook shared secret. Accepts an array so a rotation does not drop
   * deliveries already in flight under the previous secret.
   */
  readonly webhookSecret: string | readonly string[];
  readonly redirectUrl?: string;
  readonly cancelUrl?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const API_BASE = "https://api.commerce.coinbase.com";
/** Pinned so a future default at Coinbase cannot silently change field shapes. */
const API_VERSION = "2018-03-22";
const CHECKOUT_EXPIRY_MS = 60 * 60 * 1000;
const FETCH_PAGE_LIMIT = 100;

/**
 * Ceiling on list requests per reconciliation window. Bounds one run if the
 * cursor never terminates, which an unbounded loop would turn into a hang.
 */
const MAX_LIST_PAGES = 50;

interface CoinbaseEnvelope<T> {
  readonly data?: T;
  readonly error?: { readonly type?: string; readonly message?: string };
  readonly pagination?: {
    readonly limit?: number;
    readonly yielded?: number;
    readonly cursor_range?: readonly string[];
  };
}

interface CoinbaseChargeResult extends CoinbaseCommerceCharge {
  readonly hosted_url?: string;
}

/**
 * Micros → USD decimal string. Pure bigint so no float rounding can enter an
 * amount; micros carry more precision than the two decimals Coinbase prices in,
 * and the surplus is truncated rather than rounded up.
 */
function microsToUsd(amountMicros: bigint): string {
  const cents = amountMicros / 10_000n;
  const whole = cents / 100n;
  const fractional = cents % 100n;
  return `${whole}.${fractional.toString().padStart(2, "0")}`;
}

function readErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } };
    const message = json.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // fall through to the raw body
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

export function createCoinbaseCommerceAdapter(
  config: CoinbaseCommerceAdapterConfig,
): PaymentProviderAdapter {
  const id = config.id ?? "coinbase-commerce";
  const fetcher = config.fetcher ?? fetch;
  const secrets: readonly string[] = Array.isArray(config.webhookSecret)
    ? (config.webhookSecret as readonly string[])
    : [config.webhookSecret as string];

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-CC-Api-Key": config.apiKey,
      "X-CC-Version": API_VERSION,
    };
  }

  return {
    id,
    displayName: "Coinbase Commerce",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD") {
        throw new UnsupportedCurrencyError(
          `Coinbase Commerce adapter requires USD; received '${input.currencyCode}'`,
        );
      }

      const description = input.orderInfo ?? `Payment ${input.transactionId}`;
      const body: Record<string, unknown> = {
        name: "Account top-up",
        description: description.slice(0, 200),
        // fixed_price, not no_price: paykit is charging a specific amount, and a
        // no_price charge would let the payer send anything at all.
        pricing_type: "fixed_price",
        local_price: { amount: microsToUsd(input.amountMicros), currency: "USD" },
        // The only key that ties an inbound event back to a paykit row. Coinbase
        // echoes metadata on every event for the charge.
        metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: input.transactionId },
      };
      const redirectUrl = input.returnUrl ?? config.redirectUrl;
      if (redirectUrl) body.redirect_url = redirectUrl;
      if (config.cancelUrl) body.cancel_url = config.cancelUrl;

      const res = await fetcher(`${API_BASE}/charges`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Coinbase Commerce charge creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }

      const json = (await res.json()) as CoinbaseEnvelope<CoinbaseChargeResult>;
      const charge = json.data;
      if (!charge?.hosted_url) {
        throw new Error("Coinbase Commerce charge creation returned no hosted_url");
      }

      // No providerSessionId: the server falls back to provider_ref =
      // transactionId, which is what the charge metadata carries back on every
      // webhook. Returning the charge id or code here would break that lookup.
      return {
        webUrl: charge.hosted_url,
        qrUrl: charge.hosted_url,
        expiresAt:
          typeof charge.expires_at === "string" && !Number.isNaN(Date.parse(charge.expires_at))
            ? new Date(charge.expires_at)
            : new Date(Date.now() + CHECKOUT_EXPIRY_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      return verifyCoinbaseCommerceSignature(rawBody, headers, secrets);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let envelope: CoinbaseCommerceEventEnvelope;
      try {
        envelope = JSON.parse(rawBody) as CoinbaseCommerceEventEnvelope;
      } catch {
        // Null rather than a throw: an unparseable body is acknowledged and
        // dropped, where a throw would answer 400 and invite redelivery of
        // something that will never parse.
        return null;
      }
      return parseCoinbaseCommerceEvent(envelope);
    },

    async refund(_input: RefundInput): Promise<RefundResult> {
      // The provider has no refund endpoint at all — refunds happen from the
      // merchant's Coinbase account. `unsupported` tells the server to release the
      // reservation and answer 501 so an operator uses the ledger adjustment
      // route, which is the only honest outcome available here.
      return {
        state: "unsupported",
        error: {
          providerCode: "REFUND_NOT_SUPPORTED",
          message:
            "Coinbase Commerce exposes no refund API; refund from the Coinbase merchant account and record it with a ledger adjustment",
        },
      };
    },

    /**
     * Every settled charge in the window, following the cursor to the end.
     *
     * The list endpoint has no date filter, so the window is applied here by
     * `confirmed_at` and paging walks back until a page falls entirely before
     * `since`. Records are keyed on paykit's own reference from charge metadata:
     * a charge created outside paykit has no such key and is skipped rather than
     * reported as an unknown payment.
     *
     * Pagination follows Coinbase's documented `starting_after` cursor and the
     * `pagination.cursor_range` it returns. On failure this throws: an empty list
     * is read by the reconciler as "the merchant settled nothing in this window",
     * so swallowing an error would record a failed run as a clean reconciliation.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const since = window.since.getTime();
      const until = (window.until ?? new Date()).getTime();

      const records: ProviderTxnRecord[] = [];
      let startingAfter: string | undefined;
      let pages = 0;

      while (pages < MAX_LIST_PAGES) {
        const params = new URLSearchParams({ limit: String(FETCH_PAGE_LIMIT) });
        if (startingAfter !== undefined) params.set("starting_after", startingAfter);

        const res = await fetcher(`${API_BASE}/charges?${params.toString()}`, {
          method: "GET",
          headers: authHeaders(),
        });
        if (!res.ok) {
          throw new Error(`Coinbase Commerce list charges failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as CoinbaseEnvelope<readonly CoinbaseChargeResult[]>;
        const page = json.data ?? [];

        for (const charge of page) {
          const reference = charge.metadata?.[PAYKIT_REFERENCE_METADATA_KEY];
          if (typeof reference !== "string" || reference === "") continue;
          if (typeof charge.confirmed_at !== "string") continue;
          const confirmedAt = Date.parse(charge.confirmed_at);
          if (Number.isNaN(confirmedAt) || confirmedAt < since || confirmedAt >= until) continue;

          const priced = charge.pricing?.local?.amount ?? charge.local_price?.amount;
          if (priced === undefined) continue;
          const n = Number(priced);
          if (!Number.isFinite(n) || n < 0) continue;
          records.push({
            providerRef: reference,
            amountMicros: BigInt(Math.round(n * 1_000_000)).toString(),
            currencyCode: (charge.pricing?.local?.currency ?? "USD").toUpperCase(),
          });
        }

        pages += 1;

        // Newest first, so once a whole page predates the window there is nothing
        // older left to find and paging can stop.
        const oldestOnPage = page.reduce<number | undefined>((oldest, charge) => {
          const created = Date.parse(charge.created_at ?? "");
          if (Number.isNaN(created)) return oldest;
          return oldest === undefined || created < oldest ? created : oldest;
        }, undefined);
        if (oldestOnPage !== undefined && oldestOnPage < since) break;

        const cursorRange = json.pagination?.cursor_range ?? [];
        const next = cursorRange[cursorRange.length - 1];
        if (page.length < FETCH_PAGE_LIMIT || typeof next !== "string" || next === "") break;
        startingAfter = next;
      }

      if (pages >= MAX_LIST_PAGES) {
        // Returning quietly would present a truncated list as complete, and the
        // reconciler would report every charge past the ceiling as missing.
        throw new Error(
          `Coinbase Commerce list charges exceeded ${MAX_LIST_PAGES} pages; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
