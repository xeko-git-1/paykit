/**
 * Momo PaymentProviderAdapter — V1.5.
 *
 * V1.5 sandbox-only by default; production requires MMOP partner business KYC.
 * - Web flow: payUrl redirects user to Momo-hosted payment page
 * - Mobile flow: deeplink (momo://) opens Momo app directly
 * - QR fallback: qrCodeUrl for cross-device scan
 *
 * Refund: idempotent via `requestId`. Same requestId → Momo returns same response.
 */
import type {
  CheckoutResult,
  CreateCheckoutInput,
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderTxnRecord,
  RefundInput,
  RefundResult,
  WebhookEventType,
} from "@vibecc/paykit";
import {
  buildCreateOrderCanonical,
  buildRefundCanonical,
  sign,
  verifyIpnSignature,
} from "./signature.js";

export interface MomoAdapterConfig {
  readonly id?: string;
  readonly partnerCode: string;
  readonly accessKey: string;
  readonly secretKey: string | readonly string[];
  readonly returnUrl: string;
  readonly ipnUrl: string;
  readonly environment?: "sandbox" | "production";
}

const SANDBOX_BASE = "https://test-payment.momo.vn";
const PRODUCTION_BASE = "https://payment.momo.vn";
const CHECKOUT_EXPIRY_MS = 30 * 60 * 1000;

interface MomoCreateResponse {
  readonly resultCode: number;
  readonly message?: string;
  readonly payUrl?: string;
  readonly deeplink?: string;
  readonly qrCodeUrl?: string;
}

interface MomoIpnPayload {
  readonly partnerCode: string;
  readonly orderId: string;
  readonly requestId: string;
  readonly amount: string;
  readonly resultCode: number;
  readonly message?: string;
  readonly transId?: string;
  readonly responseTime?: string;
  readonly signature: string;
  readonly extraData?: string;
  readonly orderType?: string;
  readonly payType?: string;
}

interface MomoRefundResponse {
  readonly resultCode: number;
  readonly message?: string;
  readonly transId?: string;
}

function mapResultCodeToEventType(code: number): WebhookEventType {
  if (code === 0) return "payment.completed";
  if (code === 1006) return "unknown";
  return "payment.failed";
}

export function createMomoAdapter(config: MomoAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "momo";
  const env = config.environment ?? "sandbox";
  const baseUrl = env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  const secrets = Array.isArray(config.secretKey)
    ? (config.secretKey as readonly string[])
    : [config.secretKey as string];
  const primarySecret = secrets[0] ?? "";

  return {
    id,
    displayName: "MoMo",
    supportedCurrencies: ["VND"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "VND") {
        throw new Error(`Momo supports VND only; received '${input.currencyCode}'`);
      }
      const vnd = input.amountMicros / 1_000_000n;
      const amount = vnd.toString();
      const requestId = `${input.transactionId}-${Date.now()}`;
      const orderId = input.transactionId;
      const orderInfo = input.orderInfo ?? `Payment ${input.transactionId}`;
      const extraData = "";
      const requestType = "payWithMethod";

      const canonical = buildCreateOrderCanonical({
        accessKey: config.accessKey,
        amount,
        extraData,
        ipnUrl: input.ipnUrl ?? config.ipnUrl,
        orderId,
        orderInfo,
        partnerCode: config.partnerCode,
        redirectUrl: input.returnUrl ?? config.returnUrl,
        requestId,
        requestType,
      });
      const signature = sign(canonical, primarySecret);

      const body = {
        partnerCode: config.partnerCode,
        accessKey: config.accessKey,
        requestId,
        amount,
        orderId,
        orderInfo,
        redirectUrl: input.returnUrl ?? config.returnUrl,
        ipnUrl: input.ipnUrl ?? config.ipnUrl,
        extraData,
        requestType,
        signature,
        lang: "vi",
      };

      const res = await fetch(`${baseUrl}/v2/gateway/api/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Momo create-order returned HTTP ${res.status}`);
      }
      const json = (await res.json()) as MomoCreateResponse;
      if (json.resultCode !== 0) {
        throw new Error(`Momo create-order failed: ${json.resultCode} ${json.message ?? ""}`);
      }
      return {
        webUrl: json.payUrl ?? "",
        ...(json.deeplink !== undefined ? { mobileDeeplink: json.deeplink } : {}),
        ...(json.qrCodeUrl !== undefined ? { qrUrl: json.qrCodeUrl } : {}),
        expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_MS),
        providerSessionId: orderId,
      };
    },

    verifyWebhookSignature(rawBody: string, _headers: Record<string, string>): boolean {
      let payload: MomoIpnPayload;
      try {
        payload = JSON.parse(rawBody) as MomoIpnPayload;
      } catch {
        return false;
      }
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null) params[k] = String(v);
      }
      return verifyIpnSignature(params, secrets, payload.signature ?? "");
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let payload: MomoIpnPayload;
      try {
        payload = JSON.parse(rawBody) as MomoIpnPayload;
      } catch {
        return null;
      }
      if (!payload.orderId) return null;
      const type = mapResultCodeToEventType(payload.resultCode);
      if (type === "unknown") return null;

      const amountMicros = /^\d+$/.test(payload.amount)
        ? (BigInt(payload.amount) * 1_000_000n).toString()
        : undefined;

      return {
        eventId: `momo:${payload.requestId ?? payload.orderId}:${payload.transId ?? "0"}`,
        type,
        providerRef: payload.orderId,
        ...(amountMicros !== undefined ? { amountMicros } : {}),
        currencyCode: "VND",
        metadata: {
          resultCode: payload.resultCode,
          message: payload.message,
          transId: payload.transId,
          payType: payload.payType,
          responseTime: payload.responseTime,
        },
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const transId = input.providerRef ?? "";
      if (!transId) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_TRANS_ID",
            message: "Momo refund requires original transId via providerRef",
          },
        };
      }
      const vnd = input.amountMicros / 1_000_000n;
      const amount = vnd.toString();
      const orderId = `${input.transactionId}-refund-${input.idempotencyKey}`;
      const description = input.reason;

      const canonical = buildRefundCanonical({
        accessKey: config.accessKey,
        amount,
        description,
        orderId,
        partnerCode: config.partnerCode,
        requestId: input.idempotencyKey,
        transId,
      });
      const signature = sign(canonical, primarySecret);

      const body = {
        partnerCode: config.partnerCode,
        accessKey: config.accessKey,
        requestId: input.idempotencyKey,
        amount,
        orderId,
        transId,
        description,
        signature,
        lang: "vi",
      };

      try {
        const res = await fetch(`${baseUrl}/v2/gateway/api/refund`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          return {
            state: "failed",
            error: {
              providerCode: `HTTP_${res.status}`,
              message: `Momo refund returned ${res.status}`,
            },
          };
        }
        const json = (await res.json()) as MomoRefundResponse;
        if (json.resultCode === 0) {
          return {
            state: "completed",
            ...(json.transId !== undefined ? { providerRefundId: json.transId } : {}),
          };
        }
        return {
          state: "failed",
          error: {
            providerCode: String(json.resultCode),
            message: json.message ?? "Momo refund failed",
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
      return [];
    },
  };
}
