/**
 * BitPay PaymentProviderAdapter — V3.
 *
 * Endpoints:
 *   POST /invoices          — create checkout (POS-facade token; no signing)
 *   GET  /invoices/:id      — fetch-back authoritative status (POS token)
 *   POST /refunds           — request refund (MERCHANT facade — ECDSA signed)
 *   GET  /refunds/:id       — fetch-back authoritative refund (MERCHANT facade)
 *   GET  /invoices?dateStart=&dateEnd=&limit=&offset=  — list (MERCHANT facade)
 *
 * Webhook trust model (CRITICAL): BitPay does NOT sign its IPNs. The POSTed
 * body is an untrusted trigger only. Authentication is "fetch-back": the
 * adapter re-fetches the resource from BitPay and trusts that response.
 * This is why the adapter implements the async `resolveWebhook` hook instead of
 * the sync verify+parse pair (verifyWebhookSignature/parseWebhookPayload are
 * implemented fail-closed so the sync path can never credit on unverified data).
 *
 * Two resources arrive on the same IPN endpoint: invoice notifications resolve
 * via GET /invoices/:id, refund notifications via GET /refunds/:id (see
 * refund-webhook.ts). They must be told apart before fetching, because a refund
 * trigger's `data.id` is a refund id and would 404 against /invoices.
 *
 * Facade split: invoice create + fetch-back use the POS token (zero crypto).
 * Refunds and reconciliation listing require BitPay's MERCHANT facade, which
 * signs each request with ECDSA secp256k1. That signer is INJECTED via
 * `merchantSigner` (consumer wires BitPay's official SDK / a KMS-backed signer)
 * so this package keeps zero runtime deps and ships no unverified crypto. With
 * no signer, refund returns state='failed' and fetchTransactions returns [].
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
import { extractRefundTriggerId, resolveRefundWebhook } from "./refund-webhook.js";
import { type BitpayInvoice, invoiceToEvent } from "./webhook-events.js";

/**
 * Merchant-facade request signer (BitPay ECDSA secp256k1). Injected so this
 * package carries no crypto implementation it cannot verify against the live
 * API. Implementations return BitPay's `x-identity` + `x-signature` headers for
 * the given full URL + JSON body.
 */
export interface BitpayMerchantSigner {
  sign(
    fullUrl: string,
    body: string,
  ): { identity: string; signature: string } | Promise<{ identity: string; signature: string }>;
}

export interface BitpayAdapterConfig {
  readonly id?: string;
  /** POS-facade token — invoice create + fetch-back GET /invoices/:id. */
  readonly apiToken: string;
  /** Merchant-facade ECDSA signer — required for refund + fetchTransactions. */
  readonly merchantSigner?: BitpayMerchantSigner;
  readonly notificationUrl?: string;
  readonly redirectUrl?: string;
  readonly environment?: "sandbox" | "production";
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const PRODUCTION_BASE = "https://bitpay.com";
const SANDBOX_BASE = "https://test.bitpay.com";
const API_VERSION = "2.0.0";
const FETCH_PAGE_LIMIT = 100;

/**
 * Ceiling on list requests per reconciliation window. Bounds one run if the
 * offset parameter is not honoured and every request returns a full page.
 */
const MAX_LIST_PAGES = 50;

interface BitpayEnvelope<T> {
  readonly data?: T;
}

function microsToUsd(amountMicros: bigint): string {
  const cents = amountMicros / 10_000n;
  const whole = cents / 100n;
  const fractional = cents % 100n;
  return `${whole}.${fractional.toString().padStart(2, "0")}`;
}

function readErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: string; message?: string };
    const msg = json.error ?? json.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // fall through
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

/** BitPay IPN trigger → invoice id. New flow nests under data.id; legacy is flat. */
function extractInvoiceId(trigger: unknown): string | undefined {
  if (typeof trigger !== "object" || trigger === null) return undefined;
  const t = trigger as { id?: unknown; data?: { id?: unknown } };
  const nested = t.data?.id;
  if (typeof nested === "string" && nested !== "") return nested;
  if (typeof nested === "number") return String(nested);
  if (typeof t.id === "string" && t.id !== "") return t.id;
  if (typeof t.id === "number") return String(t.id);
  return undefined;
}

export function createBitpayAdapter(config: BitpayAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "bitpay";
  const env = config.environment ?? "sandbox";
  const baseUrl = env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  const fetcher = config.fetcher ?? fetch;

  /**
   * POS-facade fetch-back of the authoritative invoice. Returns null when the
   * invoice cannot be read, so callers skip instead of acting on the untrusted
   * IPN body. Shared by the invoice-status and refund paths — the refund path
   * needs it to recover `orderId`, which is the only key the server can use to
   * locate the payment row.
   */
  async function fetchInvoice(invoiceId: string): Promise<BitpayInvoice | null> {
    const res = await fetcher(
      `${baseUrl}/invoices/${encodeURIComponent(invoiceId)}?token=${encodeURIComponent(config.apiToken)}`,
      { method: "GET", headers: { "X-Accept-Version": API_VERSION } },
    );
    if (!res.ok) return null;
    try {
      const json = (await res.json()) as BitpayEnvelope<BitpayInvoice>;
      return json.data ?? (json as unknown as BitpayInvoice);
    } catch {
      return null;
    }
  }

  return {
    id,
    displayName: "BitPay",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD") {
        throw new UnsupportedCurrencyError(
          `BitPay adapter requires USD; received '${input.currencyCode}'`,
        );
      }

      const body = JSON.stringify({
        token: config.apiToken,
        price: Number(microsToUsd(input.amountMicros)),
        currency: "USD",
        orderId: input.transactionId,
        itemDesc: input.orderInfo ?? `Payment ${input.transactionId}`,
        notificationURL: input.ipnUrl ?? config.notificationUrl,
        redirectURL: input.returnUrl ?? config.redirectUrl,
      });

      const res = await fetcher(`${baseUrl}/invoices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Accept-Version": API_VERSION,
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `BitPay invoice creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }
      const json = (await res.json()) as BitpayEnvelope<
        BitpayInvoice & { url?: string; expirationTime?: number }
      >;
      const invoice =
        json.data ?? (json as unknown as BitpayInvoice & { url?: string; expirationTime?: number });

      // Do NOT return the BitPay invoice id as providerSessionId. Both the
      // credit path (resolveWebhook → invoiceToEvent) and reconciliation
      // (fetchTransactions) key the payment on `orderId` (= transactionId), not
      // the invoice id. Storing the invoice id here would make the webhook
      // lookup miss and the payment would never credit. Omitting it lets the
      // server fall back to transactionId. (The invoice id survives in the
      // webhook event metadata for refund/audit use.)
      return {
        webUrl: invoice.url ?? "",
        qrUrl: invoice.url ?? "",
        expiresAt:
          typeof invoice.expirationTime === "number"
            ? new Date(invoice.expirationTime)
            : new Date(Date.now() + 15 * 60 * 1000),
      };
    },

    // BitPay webhooks are unsigned — the sync path must never trust them.
    // Fail closed: signature invalid, payload unparseable. Real resolution
    // happens in resolveWebhook (fetch-back). These exist only to satisfy the
    // interface and to fail safely if ever invoked directly.
    verifyWebhookSignature(): boolean {
      return false;
    },

    parseWebhookPayload(): NormalizedWebhookEvent | null {
      return null;
    },

    async resolveWebhook(
      rawBody: string,
      _headers: Record<string, string>,
    ): Promise<NormalizedWebhookEvent | null> {
      let trigger: unknown;
      try {
        trigger = JSON.parse(rawBody);
      } catch {
        return null;
      }

      // Refunds live on a separate BitPay resource whose `data.id` is a REFUND
      // id, so it must be classified before the invoice path — fetching
      // /invoices/<refundId> would 404 and drop the ledger debit.
      const refundId = extractRefundTriggerId(trigger);
      if (refundId !== undefined) {
        return resolveRefundWebhook(
          {
            baseUrl,
            apiToken: config.apiToken,
            apiVersion: API_VERSION,
            fetcher,
            ...(config.merchantSigner ? { merchantSigner: config.merchantSigner } : {}),
            fetchInvoice,
          },
          refundId,
        );
      }

      const invoiceId = extractInvoiceId(trigger);
      if (!invoiceId) return null;

      // Fetch-back: trust BitPay's API response, not the IPN body.
      const invoice = await fetchInvoice(invoiceId);
      if (invoice === null) return null; // can't authenticate → skip (BitPay retries)
      return invoiceToEvent(invoice);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const invoiceId = input.providerRef ?? "";
      if (!invoiceId) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_INVOICE_ID",
            message: "BitPay refund requires the invoice id via providerRef on the transaction",
          },
        };
      }
      if (!config.merchantSigner) {
        return {
          state: "failed",
          error: {
            providerCode: "NO_MERCHANT_SIGNER",
            message:
              "BitPay refunds require the merchant facade (ECDSA). Inject `merchantSigner` to enable refunds.",
          },
        };
      }

      const url = `${baseUrl}/refunds`;
      const body = JSON.stringify({
        token: config.apiToken,
        invoiceId,
        amount: Number(microsToUsd(input.amountMicros)),
      });

      let signed: { identity: string; signature: string };
      try {
        signed = await config.merchantSigner.sign(url, body);
      } catch (err) {
        return {
          state: "failed",
          error: {
            providerCode: "SIGNER_ERROR",
            message: `BitPay merchantSigner threw: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      let res: Response;
      try {
        res = await fetcher(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Accept-Version": API_VERSION,
            "x-identity": signed.identity,
            "x-signature": signed.signature,
          },
          body,
        });
      } catch (err) {
        return {
          state: "pending_webhook",
          error: {
            providerCode: "NETWORK_ERROR",
            message: `BitPay refund call failed; awaiting webhook. ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      if (!res.ok) {
        const text = await res.text();
        return {
          state: "pending_webhook",
          error: {
            providerCode: `HTTP_${res.status}`,
            message: `BitPay refund returned HTTP ${res.status}; awaiting confirmation. ${readErrorMessage(text)}`,
          },
        };
      }

      // BitPay creates refunds in status 'pending' and confirms asynchronously,
      // so no debit is written here. The refund IPN (resolveWebhook → refund
      // fetch-back) emits payment.refunded once BitPay reports the money as
      // actually sent, which is what moves the ledger.
      return {
        state: "pending_webhook",
        error: {
          providerCode: "REFUND_PENDING",
          message:
            "BitPay refund accepted in 'pending'; ledger debit is written when the refund IPN reports it settled",
        },
      };
    },

    /**
     * Every settled invoice in the window, following offsets to the end.
     *
     * A missing merchant signer now throws instead of returning an empty array.
     * The rail CAN list — the deployment just has not been given the credential
     * for it — and an empty list is read downstream as "the merchant settled
     * nothing in this window", which would report every stored payment as missing
     * at the provider and record the run as a clean reconciliation. A throw names
     * the real problem and leaves the window to be covered once it is fixed.
     *
     * `offset` comes from the documented request shape and is not verified here.
     * The loop stops on a short page, which holds regardless of how paging is
     * spelled, and refuses to run past a hard ceiling.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      if (!config.merchantSigner) {
        throw new Error(
          "BitPay reconciliation requires a merchantSigner (merchant-facade ECDSA); configure one or exclude bitpay from the reconciliation run",
        );
      }

      // Day granularity is all the filter accepts, so the request can span a
      // little more than the window. Harmless: matching is by reference, and a
      // record outside the window simply finds no row to claim.
      const dateStart = window.since.toISOString().slice(0, 10);
      const dateEnd = (window.until ?? new Date()).toISOString().slice(0, 10);

      const records: ProviderTxnRecord[] = [];
      let offset = 0;
      let sawFullPage = true;
      let pages = 0;

      while (sawFullPage && pages < MAX_LIST_PAGES) {
        const params = new URLSearchParams({
          token: config.apiToken,
          dateStart,
          dateEnd,
          limit: String(FETCH_PAGE_LIMIT),
          offset: String(offset),
        });
        const url = `${baseUrl}/invoices?${params.toString()}`;

        const signed = await config.merchantSigner.sign(url, "");
        const res = await fetcher(url, {
          method: "GET",
          headers: {
            "X-Accept-Version": API_VERSION,
            "x-identity": signed.identity,
            "x-signature": signed.signature,
          },
        });
        if (!res.ok) {
          throw new Error(`BitPay list invoices failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as BitpayEnvelope<readonly BitpayInvoice[]>;
        const data = json.data ?? [];

        for (const invoice of data) {
          if (invoice.status !== "complete" && invoice.status !== "confirmed") continue;
          if (!invoice.orderId) continue;
          const n = typeof invoice.price === "number" ? invoice.price : Number(invoice.price);
          if (!Number.isFinite(n) || n < 0) continue;
          records.push({
            providerRef: invoice.orderId,
            amountMicros: BigInt(Math.round(n * 1_000_000)).toString(),
            currencyCode:
              typeof invoice.currency === "string" ? invoice.currency.toUpperCase() : "USD",
          });
        }

        sawFullPage = data.length >= FETCH_PAGE_LIMIT;
        offset += FETCH_PAGE_LIMIT;
        pages += 1;
      }

      if (sawFullPage) {
        throw new Error(
          `BitPay list invoices exceeded ${MAX_LIST_PAGES} pages for the window; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
