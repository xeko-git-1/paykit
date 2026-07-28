import { randomBytes } from "node:crypto";
/**
 * Binance Pay PaymentProviderAdapter — off-chain crypto payments settled inside
 * the payer's Binance wallet (NOT an on-chain transfer; no chain/network to pin).
 *
 * Endpoints (base https://bpay.binanceapi.com):
 *   POST /binancepay/openapi/v3/order      — create order (hosted checkout + QR + deeplink)
 *   POST /binancepay/openapi/order/refund  — refund, keyed on prepayId
 *
 * Request auth (symmetric, merchant-side):
 *   BinancePay-Timestamp, BinancePay-Nonce, BinancePay-Certificate-SN (= api key),
 *   BinancePay-Signature = hex(HMAC_SHA512(ts + "\n" + nonce + "\n" + body + "\n")).toUpperCase()
 * Binance only accepts a request within ~1s of its timestamp, so the host clock
 * must be NTP-synced or every call fails with 400003.
 *
 * Webhook auth (asymmetric, Binance-side): RSA-SHA256 over the same canonical
 * payload, signature base64. The merchant supplies Binance's public key
 * (`certPublic` from POST /binancepay/openapi/certificates) via config, which
 * keeps verifyWebhookSignature synchronous — see index.ts for why that design
 * was chosen over fetching the cert per webhook.
 *
 * providerRef round-trip: createCheckout does NOT return providerSessionId, so
 * the server stores provider_ref = transactionId. Binance echoes it as
 * `merchantTradeNo` in every notification (hyphen-compacted, see
 * merchant-trade-no.ts) so the router's (provider, provider_ref) lookup matches.
 * `prepayId` is Binance's own id — it travels in metadata + providerPaymentId,
 * never as providerRef.
 *
 * UNVERIFIED AGAINST LIVE API: Binance Pay has no public sandbox (a trial
 * merchant account must be requested through support), so every request/response
 * field below is built from the published spec only. Highest-risk items, all
 * flagged inline: the USD `currency` path requires merchant onboarding
 * (non-onboarded merchants must price in USDT and paykit will quarantine those),
 * goodsDetails category/type codes, and the refund `refundStatus` enum.
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
} from "@vibecc/paykit";
import { toMerchantTradeNo } from "./merchant-trade-no.js";
import { type BinanceNotificationEnvelope, parseBinanceNotification } from "./webhook-events.js";
import { generateNonce, signRequest, verifyBinanceWebhookSignature } from "./webhook-verifier.js";

export interface BinanceAdapterConfig {
  readonly id?: string;
  /** Binance Pay API key — sent as BinancePay-Certificate-SN. */
  readonly apiKey: string;
  /** Binance Pay API secret — HMAC-SHA512 key for request signatures. */
  readonly apiSecret: string;
  /**
   * Binance's webhook public key (`certPublic` from the Query Certificate API).
   * Accepts an array so a Binance certificate rotation does not drop in-flight
   * webhooks. Without it every webhook fails verification, since this adapter
   * deliberately does not fetch certificates at request time.
   */
  readonly webhookPublicKey: string | readonly string[];
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  /** Per-order webhook URL; overrides the merchant-platform setting. */
  readonly webhookUrl?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const API_BASE = "https://bpay.binanceapi.com";
const CHECKOUT_EXPIRY_MS = 60 * 60 * 1000;
const SUCCESS_CODE = "000000";

interface BinanceEnvelope<T> {
  readonly status?: string;
  readonly code?: string;
  readonly data?: T;
  readonly errorMessage?: string;
}

interface BinanceOrderResult {
  readonly prepayId?: string;
  readonly terminalType?: string;
  readonly expireTime?: number;
  readonly qrcodeLink?: string;
  readonly qrContent?: string;
  readonly checkoutUrl?: string;
  readonly deeplink?: string;
  readonly universalUrl?: string;
  readonly currency?: string;
  readonly totalFee?: string;
}

interface BinanceRefundResult {
  readonly refundId?: number | string;
  readonly refundRequestId?: string;
  readonly prepayId?: string;
  readonly refundStatus?: string;
  readonly duplicateRequest?: string;
  readonly remainingAttempts?: number;
}

/**
 * Micros -> Binance decimal amount. Binance accepts up to 8 decimal places;
 * paykit micros carry 6, so the value is exact with no rounding.
 */
function microsToDecimal(amountMicros: bigint): string {
  const whole = amountMicros / 1_000_000n;
  const fraction = amountMicros % 1_000_000n;
  if (fraction === 0n) return `${whole}.00`;
  const padded = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${padded.length < 2 ? padded.padEnd(2, "0") : padded}`;
}

function readErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { errorMessage?: string; code?: string };
    const parts = [json.code, json.errorMessage].filter(
      (p): p is string => typeof p === "string" && p !== "",
    );
    if (parts.length > 0) return parts.join(" ");
  } catch {
    // fall through to the raw body
  }
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
}

export function createBinanceAdapter(config: BinanceAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "binance";
  const fetcher = config.fetcher ?? fetch;
  const publicKeys: readonly string[] = Array.isArray(config.webhookPublicKey)
    ? (config.webhookPublicKey as readonly string[])
    : [config.webhookPublicKey as string];

  /** POST with the four required auth headers, signing the exact bytes sent. */
  async function signedPost(path: string, body: Record<string, unknown>): Promise<Response> {
    const serialized = JSON.stringify(body);
    const timestamp = Date.now().toString();
    const nonce = generateNonce(randomBytes);
    return fetcher(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "BinancePay-Timestamp": timestamp,
        "BinancePay-Nonce": nonce,
        "BinancePay-Certificate-SN": config.apiKey,
        "BinancePay-Signature": signRequest(timestamp, nonce, serialized, config.apiSecret),
      },
      body: serialized,
    });
  }

  return {
    id,
    displayName: "Binance Pay",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "USD") {
        throw new UnsupportedCurrencyError(
          `Binance Pay adapter requires USD; received '${input.currencyCode}'`,
        );
      }

      const description = input.orderInfo ?? `Payment ${input.transactionId}`;
      const body: Record<string, unknown> = {
        env: { terminalType: "WEB" },
        // Binance caps this at 32 alphanumeric chars, so a UUID transactionId is
        // hyphen-compacted; the webhook expands it back for the router lookup.
        merchantTradeNo: toMerchantTradeNo(input.transactionId),
        // USD order pricing requires merchant onboarding for USD. Non-onboarded
        // merchants must price in a crypto currency, in which case the webhook's
        // totalFee is a coin amount and paykit quarantines instead of crediting.
        currency: "USD",
        orderAmount: microsToDecimal(input.amountMicros),
        description: description.slice(0, 256),
        goodsDetails: [
          {
            // 02 = virtual goods; Z000 = "others". paykit bills for account
            // credit, which has no more specific Binance category.
            goodsType: "02",
            goodsCategory: "Z000",
            referenceGoodsId: input.transactionId,
            // Binance rejects special characters and emoji in goodsName, so keep
            // to an ASCII-safe subset rather than risking 400103.
            goodsName: description.replace(/[^0-9a-zA-Z ._-]/g, " ").slice(0, 256) || "Payment",
          },
        ],
      };

      const returnUrl = input.returnUrl ?? config.returnUrl;
      if (returnUrl) body.returnUrl = returnUrl;
      if (config.cancelUrl) body.cancelUrl = config.cancelUrl;
      const webhookUrl = input.ipnUrl ?? config.webhookUrl;
      if (webhookUrl) body.webhookUrl = webhookUrl;
      if (input.customerEmail) body.buyer = { buyerEmail: input.customerEmail };

      const res = await signedPost("/binancepay/openapi/v3/order", body);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Binance Pay order creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }

      const json = (await res.json()) as BinanceEnvelope<BinanceOrderResult>;
      // Binance returns HTTP 200 with status=FAIL for business errors, so the
      // envelope must be checked separately from the HTTP status.
      if (json.status !== "SUCCESS" || json.code !== SUCCESS_CODE) {
        throw new Error(
          `Binance Pay order creation rejected: ${json.code ?? "?"} ${json.errorMessage ?? "unknown error"}`,
        );
      }
      const result = json.data;
      if (!result?.checkoutUrl) {
        throw new Error("Binance Pay order creation returned no checkoutUrl");
      }

      // No providerSessionId: the server falls back to provider_ref =
      // transactionId, which is what Binance echoes as merchantTradeNo. Returning
      // prepayId here would break the webhook lookup.
      return {
        webUrl: result.checkoutUrl,
        ...(result.qrcodeLink !== undefined ? { qrUrl: result.qrcodeLink } : {}),
        ...(result.deeplink !== undefined ? { mobileDeeplink: result.deeplink } : {}),
        expiresAt:
          typeof result.expireTime === "number"
            ? new Date(result.expireTime)
            : new Date(Date.now() + CHECKOUT_EXPIRY_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      return verifyBinanceWebhookSignature(rawBody, headers, publicKeys);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let envelope: BinanceNotificationEnvelope;
      try {
        envelope = JSON.parse(rawBody) as BinanceNotificationEnvelope;
      } catch {
        return null;
      }
      return parseBinanceNotification(envelope);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      // The refund API keys on prepayId, NOT merchantTradeNo. The server passes
      // provider_payment_id ?? provider_ref, and the adapter persists prepayId as
      // providerPaymentId on payment.completed — so a completed payment refunds
      // correctly. A refund attempted before any webhook arrived would receive
      // the transactionId instead, which Binance cannot resolve (400202).
      const prepayId = input.providerRef ?? "";
      if (!prepayId) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_PREPAY_ID",
            message: "Binance Pay refund requires the prepayId via providerRef on the transaction",
          },
        };
      }

      const body: Record<string, unknown> = {
        // Binance enforces idempotency on refundRequestId and reports reuse via
        // duplicateRequest, so a retried refund cannot double-pay.
        refundRequestId: input.idempotencyKey.slice(0, 64),
        prepayId,
        refundAmount: microsToDecimal(input.amountMicros),
        refundReason: input.reason.slice(0, 256),
      };

      let res: Response;
      try {
        res = await signedPost("/binancepay/openapi/order/refund", body);
      } catch (err) {
        // The request may have reached Binance before the socket failed, so the
        // refund could still succeed and notify. Never report 'failed' here —
        // that would let an operator retry into a second refund.
        return {
          state: "pending_webhook",
          error: {
            providerCode: "NETWORK_ERROR",
            message: `Binance Pay refund call failed; awaiting webhook. ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      const text = await res.text();
      let json: BinanceEnvelope<BinanceRefundResult>;
      try {
        json = JSON.parse(text) as BinanceEnvelope<BinanceRefundResult>;
      } catch {
        return {
          state: "pending_webhook",
          error: {
            providerCode: `HTTP_${res.status}`,
            message: "Binance Pay refund response was not JSON; awaiting webhook",
          },
        };
      }

      if (!res.ok || json.status !== "SUCCESS" || json.code !== SUCCESS_CODE) {
        const code = json.code ?? `HTTP_${res.status}`;
        // Deterministic rejections cannot become a refund later, so they are
        // terminal: reporting pending_webhook would strand the transaction in
        // refund_pending_webhook forever waiting for a webhook that never fires.
        if (TERMINAL_REFUND_ERROR_CODES.has(code)) {
          return {
            state: "failed",
            error: { providerCode: code, message: readErrorMessage(text) },
          };
        }
        return {
          state: "pending_webhook",
          error: {
            providerCode: code,
            message: `Binance Pay refund uncertain (${readErrorMessage(text)}); ledger debit written when the REFUND_SUCCESS webhook fires`,
          },
        };
      }

      const data = json.data;
      const refundId = data?.refundId !== undefined ? String(data.refundId) : undefined;
      // refundStatus enum per spec: INITIAL, PENDING, CANCELLED, REFUNDED.
      // Only REFUNDED is final-success; everything else resolves via webhook.
      const status = data?.refundStatus;
      if (status === "REFUNDED") {
        return {
          state: "completed",
          ...(refundId !== undefined ? { providerRefundId: refundId } : {}),
        };
      }
      if (status === "CANCELLED") {
        return {
          state: "failed",
          ...(refundId !== undefined ? { providerRefundId: refundId } : {}),
          error: { providerCode: "CANCELLED", message: "Binance Pay cancelled the refund" },
        };
      }
      return {
        state: "pending_webhook",
        ...(refundId !== undefined ? { providerRefundId: refundId } : {}),
        error: {
          providerCode: status ?? "REFUND_ACCEPTED",
          message:
            "Binance Pay refund accepted; ledger debit written when the REFUND_SUCCESS webhook fires",
        },
      };
    },

    async fetchTransactions(_window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      // Binance Pay exposes no merchant-wide date-range order list — only
      // per-order query by merchantTradeNo/prepayId. Reconciliation by window is
      // therefore impossible through this API; returning [] is honest and the
      // reconciler tolerates it. Do not substitute a fabricated listing.
      return [];
    },
  };
}

/**
 * Refund errors that are settled facts rather than transient conditions. These
 * map to state='failed' so the transaction leaves refund_pending_webhook.
 *   400202 ORDER_NOT_FOUND            400606 MERCHANT_REFUND_ACCESS_FORBIDDEN
 *   400605 AMOUNT_PRECISION_INVALID   400607 REFUND_TOO_MANY_TIMES
 *   400608 REFUND_AMOUNT_INVALID      400609 LAST_REFUND_AMOUNT_INVALID
 *   400610 MERCHANT_REFUND_LIMITATION 400100/400101/400102/400103 param errors
 * Deliberately absent: 400611 INSUFFICIENT_BALANCE and 400612 PAYMENT_PENDING,
 * which can clear on their own, and every signature/timestamp/auth code, since
 * those indicate a misconfiguration whose retry may yet succeed.
 */
const TERMINAL_REFUND_ERROR_CODES: ReadonlySet<string> = new Set([
  "400100",
  "400101",
  "400102",
  "400103",
  "400202",
  "400605",
  "400606",
  "400607",
  "400608",
  "400609",
  "400610",
]);
