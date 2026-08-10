/**
 * ZaloPay PaymentProviderAdapter — V1.5.
 *
 * createCheckout flow:
 *   1. Build app_trans_id = YYMMDD_<paykit-uuid-suffix>
 *   2. POST /v2/create signed with key1 → { order_url, zp_trans_token }
 *   3. Build mobileDeeplink: `zalopay://app/payment?token=<zp_trans_token>`
 *
 * Refund flow (2-step):
 *   1. POST /v2/refund with idempotent m_refund_id signed with key1
 *      → return_code=1 (completed) | =3 (PROCESSING) | other (failed)
 *   2. PROCESSING → return state='pending'; server writes pending_refunds row;
 *      reconciler (phase 10) polls /v2/query_refund until terminal
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
} from "@xeko-git-1/paykit";
import {
  buildAppTransId,
  buildCreateCanonical,
  buildRefundCanonical,
  signWithKey1,
  verifyCallbackMac,
} from "./signature.js";

export interface ZaloPayAdapterConfig {
  readonly id?: string;
  readonly appId: string;
  readonly key1: string;
  readonly key2: string | readonly string[];
  readonly returnUrl: string;
  readonly callbackUrl: string;
  readonly environment?: "sandbox" | "production";
}

const SANDBOX_BASE = "https://sb-openapi.zalopay.vn";
const PRODUCTION_BASE = "https://openapi.zalopay.vn";
const CHECKOUT_EXPIRY_MS = 15 * 60 * 1000;

interface ZaloPayCreateResponse {
  readonly return_code: number;
  readonly return_message?: string;
  readonly order_url?: string;
  readonly zp_trans_token?: string;
  readonly qr_code?: string;
}

interface ZaloPayCallbackData {
  readonly app_id: number;
  readonly app_trans_id: string;
  readonly amount: number;
  readonly zp_trans_id?: string;
  readonly server_time?: number;
  readonly merchant_user_id?: string;
  readonly user_fee_amount?: number;
}

interface ZaloPayCallbackEnvelope {
  readonly data: string; // JSON string
  readonly mac: string;
  readonly type?: number;
}

interface ZaloPayRefundResponse {
  readonly return_code: number;
  readonly return_message?: string;
  readonly refund_id?: string;
  readonly m_refund_id?: string;
  readonly sub_return_code?: number;
}

function mapReturnCode(code: number): WebhookEventType {
  if (code === 1) return "payment.completed";
  if (code === 2) return "payment.failed";
  return "payment.failed";
}

export function createZaloPayAdapter(config: ZaloPayAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "zalopay";
  const env = config.environment ?? "sandbox";
  const baseUrl = env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  const key2s = Array.isArray(config.key2)
    ? (config.key2 as readonly string[])
    : [config.key2 as string];

  return {
    id,
    displayName: "ZaloPay",
    supportedCurrencies: ["VND"],
    checkoutMode: "redirect",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "VND") {
        throw new Error(`ZaloPay supports VND only; received '${input.currencyCode}'`);
      }
      // ZaloPay requires app_trans_id format `YYMMDD_<id>` — derive ID suffix from
      // paykit transactionId (UUID first 8 chars). DB column internal_id (phase 03)
      // stores paykit UUID; provider_ref will store the ZaloPay app_trans_id.
      const idSuffix = input.transactionId.replace(/-/g, "").slice(0, 12);
      const appTransId = buildAppTransId(idSuffix);
      const vnd = input.amountMicros / 1_000_000n;
      const amount = vnd.toString();
      const appTime = String(Date.now());
      const embedData = JSON.stringify({
        redirecturl: input.returnUrl ?? config.returnUrl,
        paykitTransactionId: input.transactionId,
      });
      const item = "[]";

      const canonical = buildCreateCanonical({
        appId: config.appId,
        appTransId,
        appUser: input.tenantId,
        amount,
        appTime,
        embedData,
        item,
      });
      const mac = signWithKey1(canonical, config.key1);

      const body = {
        app_id: Number(config.appId),
        app_trans_id: appTransId,
        app_user: input.tenantId,
        app_time: Number(appTime),
        amount: Number(amount),
        item,
        embed_data: embedData,
        description: input.orderInfo ?? `Payment ${input.transactionId}`,
        bank_code: "",
        callback_url: config.callbackUrl,
        mac,
      };

      const res = await fetch(`${baseUrl}/v2/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`ZaloPay create-order returned HTTP ${res.status}`);
      }
      const json = (await res.json()) as ZaloPayCreateResponse;
      if (json.return_code !== 1) {
        throw new Error(
          `ZaloPay create-order failed: ${json.return_code} ${json.return_message ?? ""}`,
        );
      }
      const result: CheckoutResult = {
        webUrl: json.order_url ?? "",
        expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_MS),
        providerSessionId: appTransId,
        ...(json.zp_trans_token !== undefined
          ? { mobileDeeplink: `zalopay://app/payment?token=${json.zp_trans_token}` }
          : {}),
        ...(json.qr_code !== undefined ? { qrUrl: json.qr_code } : {}),
      };
      return result;
    },

    verifyWebhookSignature(rawBody: string, _headers: Record<string, string>): boolean {
      let envelope: ZaloPayCallbackEnvelope;
      try {
        envelope = JSON.parse(rawBody) as ZaloPayCallbackEnvelope;
      } catch {
        return false;
      }
      // ZaloPay uses key2 for callback verification (NOT key1)
      return verifyCallbackMac(envelope.data, key2s, envelope.mac);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let envelope: ZaloPayCallbackEnvelope;
      try {
        envelope = JSON.parse(rawBody) as ZaloPayCallbackEnvelope;
      } catch {
        return null;
      }
      let data: ZaloPayCallbackData;
      try {
        data = JSON.parse(envelope.data) as ZaloPayCallbackData;
      } catch {
        return null;
      }
      if (!data.app_trans_id) return null;
      // Callback for type=1 means order success in ZaloPay convention.
      // type=2 means agreement/recurring (not used in V1.5).
      const cbType = envelope.type ?? 1;
      const returnCode = cbType === 1 ? 1 : 0;
      const eventType = mapReturnCode(returnCode);

      const amountMicros = (BigInt(data.amount) * 1_000_000n).toString();
      const eventId = `zalopay:${data.app_trans_id}:${data.zp_trans_id ?? "0"}`;

      return {
        eventId,
        type: eventType,
        providerRef: data.app_trans_id,
        amountMicros,
        currencyCode: "VND",
        metadata: {
          zpTransId: data.zp_trans_id,
          serverTime: data.server_time,
          callbackType: cbType,
        },
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      // ZaloPay refund needs zp_trans_id (NOT app_trans_id). Caller passes via providerRef.
      const zpTransId = input.providerRef ?? "";
      if (!zpTransId) {
        return {
          state: "failed",
          error: {
            providerCode: "MISSING_ZP_TRANS_ID",
            message: "ZaloPay refund requires zp_trans_id via providerRef",
          },
        };
      }
      const vnd = input.amountMicros / 1_000_000n;
      const amount = vnd.toString();
      const timestamp = String(Date.now());
      const canonical = buildRefundCanonical({
        appId: config.appId,
        zpTransId,
        amount,
        description: input.reason,
        timestamp,
      });
      const mac = signWithKey1(canonical, config.key1);

      const body = {
        app_id: Number(config.appId),
        m_refund_id: input.idempotencyKey,
        zp_trans_id: zpTransId,
        amount: Number(amount),
        description: input.reason,
        timestamp: Number(timestamp),
        mac,
      };

      try {
        const res = await fetch(`${baseUrl}/v2/refund`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          return {
            state: "failed",
            error: {
              providerCode: `HTTP_${res.status}`,
              message: `ZaloPay refund returned ${res.status}`,
            },
          };
        }
        const json = (await res.json()) as ZaloPayRefundResponse;

        // return_code: 1 = success, 2 = failed, 3 = processing
        if (json.return_code === 1) {
          return {
            state: "completed",
            ...(json.refund_id !== undefined ? { providerRefundId: json.refund_id } : {}),
          };
        }
        if (json.return_code === 3) {
          // PROCESSING — server writes pending_refunds row, reconciler polls /v2/query_refund
          return {
            state: "pending",
            ...(json.refund_id !== undefined ? { providerRefundId: json.refund_id } : {}),
          };
        }
        return {
          state: "failed",
          error: {
            providerCode: String(json.return_code),
            message: json.return_message ?? "ZaloPay refund failed",
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
      // ZaloPay /v2/query is per-app_trans_id only; reconciler iterates paykit DB rows.
      return [];
    },
  };
}
