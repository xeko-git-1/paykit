/**
 * NowPayments PaymentProviderAdapter — V3.
 *
 * Endpoints:
 *   POST /v1/invoice                — create checkout
 *   GET  /v1/payment/?limit=&dateFrom=&dateTo=  — list payments (pagination)
 *   POST /v1/payment/refund         — request refund (async via webhook)
 *
 * Auth: x-api-key header on REST calls. IPN secret is separate from API key.
 *
 * Refund async semantics (Val Session 2 D8): NP's REST endpoint may return
 * 4xx/5xx OR 2xx with no `refund_id` (accepted-but-not-yet-processed). Both
 * cases → adapter returns state='pending_webhook'. Server writes
 * payment_transactions.status='refund_pending_webhook' and waits for the
 * webhook (`payment_status='refunded'`) which arrives ≤24h later.
 *
 * Refund race protection (RT F10): both admin sync-success path and webhook
 * path go through Phase 0a's appendLedgerEntryIdempotent with UNIQUE
 * (provider, source_id, entry_type='refund_debit'). Whichever fires second
 * returns inserted=false; applyDelta runs exactly once.
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
import { type NpIpnPayload, parseNpIpn } from "./webhook-events.js";
import { verifyNpSignature } from "./webhook-verifier.js";

export interface NowpaymentsAdapterConfig {
  readonly id?: string;
  readonly apiKey: string;
  readonly ipnSecret: string | readonly string[];
  /** Optional: force a specific pay currency (e.g. 'usdcmatic'). Omit to let customer choose at checkout. */
  readonly payCurrency?: string;
  readonly returnUrl?: string;
  readonly ipnUrl?: string;
  readonly environment?: "sandbox" | "production";
  /**
   * Optional fetch override for testing. Defaults to global fetch.
   * Signature matches the global fetch contract.
   */
  readonly fetcher?: typeof fetch;
}

const SANDBOX_BASE = "https://api.sandbox.nowpayments.io";
const PRODUCTION_BASE = "https://api.nowpayments.io";
const CHECKOUT_EXPIRY_MS = 60 * 60 * 1000;
const FETCH_PAGE_LIMIT = 100;

interface NpInvoiceResponse {
  readonly id: number | string;
  readonly invoice_url: string;
  readonly token_id?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

interface NpRefundResponse {
  readonly refund_id?: string | number;
  readonly status?: string;
  readonly message?: string;
}

interface NpPaymentListResponse {
  readonly data?: ReadonlyArray<{
    readonly payment_id?: number | string;
    readonly payment_status?: string;
    readonly order_id?: string;
    readonly price_amount?: number | string;
    readonly price_currency?: string;
    readonly actually_paid?: number | string;
    readonly outcome_amount?: number | string;
    readonly outcome_currency?: string;
  }>;
}

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

export function createNowpaymentsAdapter(
  config: NowpaymentsAdapterConfig,
): PaymentProviderAdapter {
  const id = config.id ?? "nowpayments";
  const env = config.environment ?? "sandbox";
  const baseUrl = env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  const fetcher = config.fetcher ?? fetch;
  const secrets: readonly string[] = Array.isArray(config.ipnSecret)
    ? (config.ipnSecret as readonly string[])
    : [config.ipnSecret as string];

  return {
    id,
    displayName: "NowPayments",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD") {
        throw new UnsupportedCurrencyError(
          `NowPayments adapter requires USD; received '${input.currencyCode}'`,
        );
      }

      const body: Record<string, unknown> = {
        price_amount: microsToUsd(input.amountMicros),
        price_currency: "usd",
        order_id: input.transactionId,
        order_description: input.orderInfo ?? `Payment ${input.transactionId}`,
        ipn_callback_url: input.ipnUrl ?? config.ipnUrl,
        success_url: input.returnUrl ?? config.returnUrl,
        cancel_url: input.returnUrl ?? config.returnUrl,
      };
      if (config.payCurrency) body.pay_currency = config.payCurrency;

      const res = await fetcher(`${baseUrl}/v1/invoice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `NowPayments invoice creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }
      const json = (await res.json()) as NpInvoiceResponse;

      // Do NOT return the NP invoice id as providerSessionId. The IPN keys the
      // payment on `order_id` (= transactionId), not the invoice id, so the
      // server must store providerRef = transactionId for the webhook lookup to
      // match. Omitting providerSessionId lets the server fall back to
      // transactionId. (The invoice id is not needed downstream — refunds key
      // on the IPN's payment_id, and reconciliation lists by order_id.)
      return {
        webUrl: json.invoice_url,
        qrUrl: json.invoice_url,
        expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      return verifyNpSignature(rawBody, headers, secrets);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let payload: NpIpnPayload;
      try {
        payload = JSON.parse(rawBody) as NpIpnPayload;
      } catch {
        return null;
      }
      return parseNpIpn(payload);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const paymentId = input.providerRef ?? "";
      if (!paymentId) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_PAYMENT_ID",
            message:
              "NowPayments refund requires the original payment_id via providerRef on the transaction",
          },
        };
      }

      const body = {
        payment_id: paymentId,
        amount: microsToUsd(input.amountMicros),
        reason: input.reason,
      };

      let res: Response;
      try {
        res = await fetcher(`${baseUrl}/v1/payment/refund`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return {
          state: "pending_webhook",
          error: {
            providerCode: "NETWORK_ERROR",
            message: `NowPayments refund call failed; awaiting webhook. ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      if (!res.ok) {
        const text = await res.text();
        return {
          state: "pending_webhook",
          error: {
            providerCode: `HTTP_${res.status}`,
            message: `NowPayments refund returned HTTP ${res.status}; ledger entry will be written when /webhooks/nowpayments fires payment.refunded. ${readErrorMessage(text)}`,
          },
        };
      }

      let json: NpRefundResponse;
      try {
        json = (await res.json()) as NpRefundResponse;
      } catch {
        return {
          state: "pending_webhook",
          error: {
            providerCode: "INVALID_RESPONSE_BODY",
            message: "NowPayments refund 2xx but body was not JSON; awaiting webhook",
          },
        };
      }

      if (json.refund_id !== undefined && json.refund_id !== null && json.refund_id !== "") {
        return {
          state: "completed",
          providerRefundId: String(json.refund_id),
        };
      }

      return {
        state: "pending_webhook",
        error: {
          providerCode: json.status ?? "ACCEPTED_NO_REFUND_ID",
          message:
            json.message ??
            "NowPayments accepted the refund but did not return refund_id; awaiting webhook",
        },
      };
    },

    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const dateFrom = window.since.toISOString();
      const dateTo = (window.until ?? new Date()).toISOString();
      const params = new URLSearchParams({
        limit: String(FETCH_PAGE_LIMIT),
        dateFrom,
        dateTo,
      });

      const res = await fetcher(`${baseUrl}/v1/payment/?${params.toString()}`, {
        method: "GET",
        headers: { "x-api-key": config.apiKey },
      });
      if (!res.ok) {
        throw new Error(`NowPayments list payments failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as NpPaymentListResponse;
      const data = json.data ?? [];

      const records: ProviderTxnRecord[] = [];
      for (const row of data) {
        if (row.payment_status !== "finished") continue;
        if (!row.order_id) continue;
        const settlementAmount = row.outcome_amount ?? row.actually_paid ?? row.price_amount;
        if (settlementAmount === undefined) continue;
        const settlementCurrency = (row.outcome_currency ?? row.price_currency ?? "USD")
          .toString()
          .toUpperCase();
        const n = typeof settlementAmount === "number" ? settlementAmount : Number(settlementAmount);
        if (!Number.isFinite(n) || n < 0) continue;
        records.push({
          providerRef: row.order_id,
          amountMicros: BigInt(Math.round(n * 1_000_000)).toString(),
          currencyCode: settlementCurrency,
        });
      }
      return records;
    },
  };
}
