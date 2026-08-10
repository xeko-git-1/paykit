/**
 * Cryptomus PaymentProviderAdapter — multi-chain USDT gateway.
 *
 * Endpoints (base https://api.cryptomus.com):
 *   POST /v1/payment          — create invoice (hosted pay page)
 *   POST /v1/payment/refund   — request refund to a payout address (async)
 *   POST /v1/payment/list     — paginated payment history (reconciliation)
 *
 * Auth: every request carries two headers —
 *   merchant: <merchant uuid>
 *   sign:     MD5( base64(JSON body) + PAYMENT_API_KEY )
 * The webhook is authenticated the same way: MD5 over base64 of the body with
 * the `sign` field removed, compared against the body's `sign`. See
 * webhook-verifier.ts for the PHP-compatible slash-escaping that the MD5 needs.
 *
 * Currency: paykit settles in USD. The customer picks a coin+chain on the
 * Cryptomus pay page (BEP20/TRC20/ERC20/Polygon USDT, etc.), or the merchant
 * pins one via `network` + `toCurrency`.
 *
 * providerRef round-trip: createCheckout does NOT return providerSessionId, so
 * the server stores provider_ref = transactionId. Cryptomus echoes that as
 * `order_id` in every webhook, so the router's (provider, provider_ref) lookup
 * matches. (uuid is Cryptomus' own id — kept in metadata for refunds/audit.)
 *
 * Refund async semantics: Cryptomus creates the refund then confirms it via a
 * later webhook (status refund_paid). The REST call returning non-2xx or a
 * non-final state maps to state='pending_webhook' so the server writes
 * status='refund_pending_webhook' and the ledger debit lands when the webhook
 * arrives (UNIQUE-protected appendLedgerEntryIdempotent).
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
import { type CryptomusWebhookPayload, parseCryptomusWebhook } from "./webhook-events.js";
import { computeCryptomusSign, verifyCryptomusSignature } from "./webhook-verifier.js";

export interface CryptomusAdapterConfig {
  readonly id?: string;
  /** Merchant UUID (Cryptomus dashboard). */
  readonly merchantId: string;
  /** Payment API key — signs REST requests AND verifies webhooks. */
  readonly paymentApiKey: string | readonly string[];
  /** Optional: force a settlement coin, e.g. 'USDT'. Omit to let the customer choose. */
  readonly toCurrency?: string;
  /** Optional: force a network/chain, e.g. 'bsc' (BEP20), 'tron' (TRC20), 'eth', 'polygon'. */
  readonly network?: string;
  readonly returnUrl?: string;
  readonly callbackUrl?: string;
  readonly environment?: "sandbox" | "production";
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const API_BASE = "https://api.cryptomus.com";
const CHECKOUT_EXPIRY_MS = 60 * 60 * 1000;

interface CryptomusEnvelope<T> {
  readonly state?: number;
  readonly result?: T;
  readonly message?: string;
}

interface CryptomusPaymentResult {
  readonly uuid?: string;
  readonly order_id?: string;
  readonly url?: string;
  readonly expired_at?: number;
}

interface CryptomusRefundResult {
  readonly result?: boolean | string;
  readonly commission?: string;
}

interface CryptomusListResult {
  readonly items?: ReadonlyArray<CryptomusWebhookPayload>;
  /**
   * Paging block as observed in the documented response shape. Only
   * `nextCursor` is acted on; the counts are read defensively because the
   * exact field set is not something this package can verify against the live
   * API, and a missing field must degrade to "no more pages" rather than throw.
   */
  readonly paginate?: {
    readonly count?: number;
    readonly hasPages?: boolean;
    readonly nextCursor?: string | null;
    readonly previousCursor?: string | null;
    readonly perPage?: number;
  };
}

/**
 * Ceiling on list requests per reconciliation window.
 *
 * Bounds one run when a cursor never terminates — a provider bug or a cursor
 * field this package guessed wrong would otherwise loop until the process dies.
 * At the documented page size this covers a large window; a genuinely larger
 * one is better served by narrowing the window than by an unbounded loop.
 */
const MAX_LIST_PAGES = 50;

function microsToUsd(amountMicros: bigint): string {
  const cents = amountMicros / 10_000n;
  const whole = cents / 100n;
  const fractional = cents % 100n;
  return `${whole}.${fractional.toString().padStart(2, "0")}`;
}

function readErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { message?: string };
    if (typeof json.message === "string" && json.message.length > 0) return json.message;
  } catch {
    // fall through
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

/**
 * `YYYY-MM-DD HH:mm:ss` in UTC, the format the payment-list filter documents.
 *
 * Built from the ISO string rather than a locale formatter so the value cannot
 * drift with the host timezone: a window shifted by the server's offset would
 * silently reconcile the wrong hours.
 */
function formatCryptomusDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function createCryptomusAdapter(config: CryptomusAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "cryptomus";
  const fetcher = config.fetcher ?? fetch;
  const apiKeys: readonly string[] = Array.isArray(config.paymentApiKey)
    ? (config.paymentApiKey as readonly string[])
    : [config.paymentApiKey as string];
  const primaryKey = apiKeys[0] ?? "";

  async function signedPost<T>(path: string, body: Record<string, unknown>): Promise<Response> {
    const { sign, serialized } = computeCryptomusSign(body, primaryKey);
    return fetcher(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        merchant: config.merchantId,
        sign,
      },
      // Send the exact bytes the sign was computed over (PHP-compatible escaping).
      body: serialized,
    });
  }

  return {
    id,
    displayName: "Cryptomus",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD") {
        throw new UnsupportedCurrencyError(
          `Cryptomus adapter requires USD; received '${input.currencyCode}'`,
        );
      }

      const body: Record<string, unknown> = {
        amount: microsToUsd(input.amountMicros),
        currency: "USD",
        order_id: input.transactionId,
        url_callback: input.ipnUrl ?? config.callbackUrl,
        url_return: input.returnUrl ?? config.returnUrl,
      };
      if (config.toCurrency) body.to_currency = config.toCurrency;
      if (config.network) body.network = config.network;

      const res = await signedPost("/v1/payment", body);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Cryptomus payment creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }
      const json = (await res.json()) as CryptomusEnvelope<CryptomusPaymentResult>;
      const result = json.result;
      if (!result || !result.url) {
        throw new Error(
          `Cryptomus payment creation returned no pay url: ${json.message ?? "unknown error"}`,
        );
      }

      // Do NOT return providerSessionId — the server stores provider_ref =
      // transactionId, which Cryptomus echoes as order_id in every webhook so
      // the (provider, provider_ref) lookup matches. The Cryptomus uuid is not
      // needed for the lookup; refunds key on order_id too.
      return {
        webUrl: result.url,
        qrUrl: result.url,
        expiresAt:
          typeof result.expired_at === "number"
            ? new Date(result.expired_at * 1000)
            : new Date(Date.now() + CHECKOUT_EXPIRY_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, _headers: Record<string, string>): boolean {
      return verifyCryptomusSignature(rawBody, apiKeys);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let payload: CryptomusWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as CryptomusWebhookPayload;
      } catch {
        return null;
      }
      return parseCryptomusWebhook(payload);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const orderId = input.providerRef ?? "";
      if (!orderId) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_ORDER_ID",
            message: "Cryptomus refund requires the order_id via providerRef on the transaction",
          },
        };
      }

      // Cryptomus refunds pay out to a customer address. paykit does not hold
      // the customer's payout address, so refunds route to the address stored on
      // the original payment via `is_subtract`; the payout address is resolved by
      // Cryptomus from the original invoice. Amount is informational for audit.
      const body: Record<string, unknown> = {
        order_id: orderId,
        amount: microsToUsd(input.amountMicros),
        is_subtract: true,
      };

      let res: Response;
      try {
        res = await signedPost("/v1/payment/refund", body);
      } catch (err) {
        return {
          state: "pending_webhook",
          error: {
            providerCode: "NETWORK_ERROR",
            message: `Cryptomus refund call failed; awaiting webhook. ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      if (!res.ok) {
        const text = await res.text();
        return {
          state: "pending_webhook",
          error: {
            providerCode: `HTTP_${res.status}`,
            message: `Cryptomus refund returned HTTP ${res.status}; ledger debit will be written when the refund_paid webhook fires. ${readErrorMessage(text)}`,
          },
        };
      }

      // Cryptomus creates the refund then confirms it via a later webhook
      // (status refund_paid). Treat a 2xx as accepted-pending; the ledger debit
      // lands when the webhook arrives (UNIQUE-protected).
      let json: CryptomusEnvelope<CryptomusRefundResult>;
      try {
        json = (await res.json()) as CryptomusEnvelope<CryptomusRefundResult>;
      } catch {
        return {
          state: "pending_webhook",
          error: {
            providerCode: "INVALID_RESPONSE_BODY",
            message: "Cryptomus refund 2xx but body was not JSON; awaiting webhook",
          },
        };
      }

      return {
        state: "pending_webhook",
        error: {
          providerCode: json.state === 0 ? "REFUND_ACCEPTED" : (json.message ?? "REFUND_PENDING"),
          message:
            "Cryptomus refund accepted; ledger debit written when the refund_paid webhook fires",
        },
      };
    },

    /**
     * Every settled payment in the window, following the cursor to the end.
     *
     * Two earlier shortcuts are deliberately gone. The window bounds were not
     * sent at all, and only the first page was read — so the reconciler received
     * an arbitrary slice and reported every payment outside it as missing at the
     * provider. Errors were also swallowed into an empty array, which claims the
     * merchant settled nothing in the window; a run that never reached Cryptomus
     * was therefore recorded as a clean reconciliation. Both now behave the way
     * the contract requires: complete, or throw.
     *
     * The date field names and the cursor field are taken from the documented
     * request/response shape and are NOT verified against the live API by this
     * package. They are handled so that a wrong guess degrades safely: an
     * unrecognised paging block ends the loop after one page, which is the old
     * behaviour, rather than looping or throwing.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const dateFrom = formatCryptomusDate(window.since);
      const dateTo = formatCryptomusDate(window.until ?? new Date());

      const records: ProviderTxnRecord[] = [];
      let cursor: string | undefined;
      let pages = 0;

      while (pages < MAX_LIST_PAGES) {
        const body: Record<string, unknown> = { date_from: dateFrom, date_to: dateTo };
        if (cursor !== undefined) body.cursor = cursor;

        // A failure here throws rather than returning what has been collected so
        // far: a partial list is indistinguishable from a complete one to the
        // reconciler, and it would fabricate a discrepancy for every payment the
        // failed page would have covered.
        const res = await signedPost("/v1/payment/list", body);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Cryptomus payment list failed: HTTP ${res.status} ${readErrorMessage(text)}`,
          );
        }

        let json: CryptomusEnvelope<CryptomusListResult>;
        try {
          json = (await res.json()) as CryptomusEnvelope<CryptomusListResult>;
        } catch {
          throw new Error("Cryptomus payment list returned a body that was not JSON");
        }

        for (const item of json.result?.items ?? []) {
          if (item.status !== "paid" && item.status !== "paid_over") continue;
          if (!item.order_id) continue;
          const amount = item.payment_amount_usd ?? item.merchant_amount ?? item.amount;
          if (amount === undefined) continue;
          const n = Number(amount);
          if (!Number.isFinite(n) || n < 0) continue;
          records.push({
            providerRef: item.order_id,
            amountMicros: BigInt(Math.round(n * 1_000_000)).toString(),
            currencyCode: "USD",
          });
        }

        pages += 1;
        const next = json.result?.paginate?.nextCursor;
        if (typeof next !== "string" || next === "") break;
        cursor = next;
      }

      if (pages >= MAX_LIST_PAGES) {
        // Silently returning here would present a truncated list as complete,
        // which is the failure this method was rewritten to remove.
        throw new Error(
          `Cryptomus payment list exceeded ${MAX_LIST_PAGES} pages for the window; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
