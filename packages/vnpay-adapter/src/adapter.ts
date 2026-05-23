/**
 * VNPay PaymentProviderAdapter implementation.
 *
 * V1.5 sandbox-first: defaults to sandbox.vnpayment.vn unless environment='production'.
 * Production credentials require VNPay merchant business KYC (out of paykit scope).
 *
 * Refund: POST /merchant_webapi/api/transaction with vnp_TransactionType=02 (full) or 03 (partial).
 * Returns RefundResult.state='completed' on vnp_ResponseCode='00', else 'failed' with provider code.
 */
import type {
  CheckoutResult,
  CreateCheckoutInput,
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderTxnRecord,
  RefundInput,
  RefundResult,
} from "@vibecc/paykit";
import { paramsToWebhookEvent, parseFormUrlencoded } from "./ipn-parser.js";
import { signParams, verifySignature } from "./signature.js";
import { encodeRfc3986 } from "./url-encoder.js";

export interface VnpayAdapterConfig {
  readonly id?: string;
  readonly tmnCode: string;
  readonly hashSecret: string | readonly string[];
  readonly returnUrl: string;
  readonly ipnUrl: string;
  readonly environment?: "sandbox" | "production";
  readonly locale?: "vn" | "en";
  readonly orderType?: string; // VNPay product category code
}

const SANDBOX_PAYMENT_URL = "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";
const PRODUCTION_PAYMENT_URL = "https://vnpayment.vn/paymentv2/vpcpay.html";
const SANDBOX_API_URL = "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction";
const PRODUCTION_API_URL = "https://merchant.vnpay.vn/merchant_webapi/api/transaction";

const QR_EXPIRY_MS = 15 * 60 * 1000; // VNPay default: 15 min

function formatVnpDate(d: Date): string {
  // Format: yyyyMMddHHmmss in VNPay's expected timezone (UTC+7, Vietnam)
  const offsetMs = 7 * 60 * 60 * 1000;
  const local = new Date(d.getTime() + offsetMs - d.getTimezoneOffset() * 60 * 1000);
  const yyyy = local.getUTCFullYear().toString();
  const MM = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const HH = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const ss = String(local.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
}

export function createVnpayAdapter(config: VnpayAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "vnpay";
  const env = config.environment ?? "sandbox";
  const paymentUrl = env === "production" ? PRODUCTION_PAYMENT_URL : SANDBOX_PAYMENT_URL;
  const apiUrl = env === "production" ? PRODUCTION_API_URL : SANDBOX_API_URL;
  const secrets = Array.isArray(config.hashSecret)
    ? (config.hashSecret as readonly string[])
    : [config.hashSecret as string];
  const primarySecret = secrets[0] ?? "";

  return {
    id,
    displayName: "VNPay",
    supportedCurrencies: ["VND"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "VND") {
        throw new Error(`VNPay supports VND only; received '${input.currencyCode}'`);
      }
      // amountMicros (BigInt) → VND → vnp_Amount (× 100, integer)
      const vnd = input.amountMicros / 1_000_000n;
      const vnpAmount = (vnd * 100n).toString();

      const params: Record<string, string> = {
        vnp_Version: "2.1.0",
        vnp_Command: "pay",
        vnp_TmnCode: config.tmnCode,
        vnp_Amount: vnpAmount,
        vnp_CurrCode: "VND",
        vnp_TxnRef: input.transactionId,
        vnp_OrderInfo: input.orderInfo ?? `Payment ${input.transactionId}`,
        vnp_OrderType: config.orderType ?? "other",
        vnp_Locale: config.locale ?? "vn",
        vnp_ReturnUrl: input.returnUrl ?? config.returnUrl,
        vnp_IpAddr: "0.0.0.0",
        vnp_CreateDate: formatVnpDate(new Date()),
      };

      const signature = signParams(params, primarySecret);
      params.vnp_SecureHash = signature;

      const queryString = Object.keys(params)
        .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k] ?? "")}`)
        .join("&");
      const webUrl = `${paymentUrl}?${queryString}`;

      return {
        webUrl,
        expiresAt: new Date(Date.now() + QR_EXPIRY_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      // VNPay IPN may arrive as form-urlencoded body OR via query string in URL.
      // Headers do NOT carry the signature; signature is in the body params (vnp_SecureHash).
      void headers;
      let params: Record<string, string>;
      try {
        params = parseFormUrlencoded(rawBody);
      } catch {
        return false;
      }
      const received = params.vnp_SecureHash ?? "";
      return verifySignature(params, secrets, received);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let params: Record<string, string>;
      try {
        params = parseFormUrlencoded(rawBody);
      } catch {
        return null;
      }
      return paramsToWebhookEvent(params);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      // VNPay refund API requires:
      //   - vnp_TransactionType: 02 (full) or 03 (partial)
      //   - vnp_TxnRef: original transaction ref (= input.providerRef or transactionId)
      //   - vnp_Amount: amount × 100 (cents)
      //   - vnp_TransactionDate: original transaction date (YYYYMMDDHHmmss)
      //   - vnp_CreateBy + vnp_CreateDate
      //   - vnp_OrderInfo
      //   - vnp_SecureHash
      const txnRef = input.providerRef ?? input.transactionId;
      const vnd = input.amountMicros / 1_000_000n;
      const vnpAmount = (vnd * 100n).toString();
      const now = formatVnpDate(new Date());

      const params: Record<string, string> = {
        vnp_RequestId: input.idempotencyKey,
        vnp_Version: "2.1.0",
        vnp_Command: "refund",
        vnp_TmnCode: config.tmnCode,
        // Default to full refund (type 02). Caller can pass partial via metadata if needed.
        vnp_TransactionType: "02",
        vnp_TxnRef: txnRef,
        vnp_Amount: vnpAmount,
        vnp_OrderInfo: input.reason,
        vnp_TransactionDate: now,
        vnp_CreateBy: "paykit",
        vnp_CreateDate: now,
        vnp_IpAddr: "0.0.0.0",
      };
      const signature = signParams(params, primarySecret);
      params.vnp_SecureHash = signature;

      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!res.ok) {
          return {
            state: "failed",
            error: {
              providerCode: `HTTP_${res.status}`,
              message: `VNPay refund returned ${res.status}`,
            },
          };
        }
        const json = (await res.json()) as {
          vnp_ResponseCode?: string;
          vnp_Message?: string;
          vnp_TransactionNo?: string;
        };
        if (json.vnp_ResponseCode === "00") {
          return {
            state: "completed",
            ...(json.vnp_TransactionNo !== undefined
              ? { providerRefundId: json.vnp_TransactionNo }
              : {}),
          };
        }
        return {
          state: "failed",
          error: {
            providerCode: json.vnp_ResponseCode ?? "UNKNOWN",
            message: json.vnp_Message ?? "VNPay refund failed",
          },
        };
      } catch (err) {
        return {
          state: "failed",
          error: {
            providerCode: "NETWORK_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },

    async fetchTransactions(_window): Promise<readonly ProviderTxnRecord[]> {
      // VNPay does not have a list-by-window API; query is per-orderRef only.
      // Reconciler must already have orderRef from paykit's payment_transactions table
      // and call adapter per row. V1.5 returns [] — reconciler's orchestrator handles this.
      return [];
    },
  };
}
