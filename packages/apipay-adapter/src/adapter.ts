/**
 * createApipayAdapter — wraps ApiPay (apipay.vn, Open Banking VND bank
 * transfers) as PaymentProviderAdapter.
 *
 * Contract:
 * - id: 'apipay'
 * - supportedCurrencies: ['VND']
 * - checkoutMode: 'redirect' (provider-hosted pay page with embedded QR;
 *   qrUrl is also returned for cross-device scan flows)
 * - createCheckout: POST /v1/client/payment-requests with HMAC-anchored
 *   content `${brandPrefix} ${transactionId}`; ApiPay matches the incoming
 *   transfer back to the request by that content
 * - parseWebhookPayload: handles event='transaction.in' only; null otherwise
 * - refund: state='unsupported' (bank transfers are one-way) with pointer to
 *   /admin/billing/ledger/adjust
 * - fetchTransactions: GET /v1/client/payment-requests?status=COMPLETED,
 *   paged to the end (reconciler treats the result as the complete window)
 *
 * Auth: `Authorization: Bearer base64(accessKey:secretKey)` on REST calls.
 * Webhook signature: HMAC-SHA256(rawBody, webhookSecret) hex in the
 * `ApiPay-Signature` header — the webhook secret is issued per webhook at
 * creation time and is SEPARATE from the API secretKey.
 *
 * Docs: https://docs.apipay.vn/vi/api/payment-requests,
 *       https://docs.apipay.vn/vi/api/webhooks
 */
import { createHmac } from "node:crypto";
import type {
  CheckoutResult,
  CreateCheckoutInput,
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderTxnRecord,
  RefundInput,
  RefundResult,
} from "@xeko-git-1/paykit";

export interface ApipayAdapterConfig {
  readonly id?: string;
  /** Public API key from dashboard (Tích hợp → API Keys). */
  readonly accessKey: string;
  /** Private API key paired with accessKey. */
  readonly secretKey: string;
  /**
   * Webhook signing secret(s) issued when the webhook endpoint is created.
   * Accepts an array for rotation; each is tried with constant-time compare.
   */
  readonly webhookSecret: string | readonly string[];
  /** Public ID of the connected bank account payment requests are created against. */
  readonly bankPublicId: string;
  readonly brandPrefix?: string;
  /** Override the API origin (tests). Defaults to https://app.apipay.vn. */
  readonly baseUrl?: string;
  /** Optional fetch override for testing. Defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://app.apipay.vn";
const CHECKOUT_EXPIRY_MS = 30 * 60 * 1000;
const FETCH_PAGE_LIMIT = 100;

/**
 * Ceiling on list requests per reconciliation window. Bounds one run if the
 * page parameter is not honoured and every request returns a full page, which
 * would otherwise loop until the process dies.
 */
const MAX_LIST_PAGES = 50;

function verifyHmac(payload: string, signature: string, secrets: readonly string[]): boolean {
  if (signature === "") return false;
  let matched = false;
  let validSecretChecked = false;
  for (const secret of secrets) {
    // An empty HMAC key yields an attacker-computable digest — skip to prevent forgery.
    if (!secret || secret.trim() === "") continue;
    validSecretChecked = true;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    if (expected.length !== signature.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  // Fail closed: if no valid secret was available, verification must not succeed.
  if (!validSecretChecked) return false;
  return matched;
}

interface ApipayWebhookPayload {
  readonly event: string;
  readonly data?: {
    readonly transactionId?: string;
    readonly referenceCode?: string;
    readonly amount?: string | number;
    readonly content?: string;
    readonly transactionDate?: string;
    readonly bankAccountPublicId?: string;
    readonly gateway?: string;
    readonly accountNumber?: string;
  };
}

interface ApipayPaymentRequestResponse {
  readonly data?: {
    readonly publicId?: string;
    readonly payUrl?: string;
    readonly qrUrl?: string;
    readonly expiresAt?: string;
  };
}

interface ApipayPaymentRequestListResponse {
  readonly data?: {
    readonly data?: ReadonlyArray<{
      readonly publicId?: string;
      readonly amount?: string | number | null;
      readonly content?: string | null;
      readonly status?: string;
    }>;
    readonly pagination?: {
      readonly page?: number;
      readonly limit?: number;
      readonly total?: number;
      readonly totalPages?: number;
    };
  };
}

/** VND amounts arrive as decimal strings (occasionally numbers); reject anything non-integral. */
function vndToMicrosString(amount: string | number): string | null {
  const raw = typeof amount === "number" ? String(amount) : amount.trim();
  if (!/^\d+$/.test(raw)) return null;
  return (BigInt(raw) * 1_000_000n).toString();
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

export function createApipayAdapter(config: ApipayAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "apipay";
  const brandPrefix = config.brandPrefix ?? "PAYKIT";
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetcher = config.fetcher ?? fetch;
  const secrets: readonly string[] = Array.isArray(config.webhookSecret)
    ? (config.webhookSecret as readonly string[])
    : [config.webhookSecret as string];
  const authHeader = `Bearer ${Buffer.from(`${config.accessKey}:${config.secretKey}`).toString("base64")}`;

  const orderRegex = new RegExp(
    `${brandPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([A-Za-z0-9-]+)`,
    "i",
  );

  function extractOrderId(content: string): string | null {
    const match = content.match(orderRegex);
    return match?.[1] ?? null;
  }

  return {
    id,
    displayName: "ApiPay",
    supportedCurrencies: ["VND"],
    checkoutMode: "redirect",
    // Bank transfer: the payer can edit the amount in their banking app before
    // confirming, and ApiPay matches the transfer back by content. A content
    // match therefore proves intent, not amount — the server must compare
    // requested vs received before crediting. See settlement-amount-guard in
    // the server package.
    settlesExactAmount: false,

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "VND") {
        throw new Error(`ApiPay adapter supports VND only; received '${input.currencyCode}'`);
      }
      // amountMicros (BigInt VND-native) → VND (1 VND = 1_000_000 micros)
      const amountVnd = input.amountMicros / 1_000_000n;
      const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MS);
      const body: Record<string, unknown> = {
        bankPublicId: config.bankPublicId,
        amount: amountVnd.toString(),
        content: `${brandPrefix} ${input.transactionId}`,
        expiresAt: expiresAt.toISOString(),
      };
      if (input.orderInfo) body.title = input.orderInfo;
      if (input.returnUrl) body.redirectUrl = input.returnUrl;

      const res = await fetcher(`${baseUrl}/v1/client/payment-requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `ApiPay payment-request creation failed: HTTP ${res.status} ${readErrorMessage(text)}`,
        );
      }
      const json = (await res.json()) as ApipayPaymentRequestResponse;
      const payUrl = json.data?.payUrl;
      if (!payUrl) {
        throw new Error("ApiPay payment-request creation returned no payUrl");
      }

      // Do NOT return the ApiPay publicId as providerSessionId. The webhook
      // keys the payment on the transfer content (= brandPrefix + transactionId),
      // so the server must store providerRef = transactionId for the webhook
      // lookup to match. Omitting providerSessionId lets the server fall back
      // to transactionId.
      return {
        webUrl: payUrl,
        ...(json.data?.qrUrl ? { qrUrl: json.data.qrUrl } : {}),
        expiresAt,
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      const signature =
        headers["apipay-signature"] ??
        headers["ApiPay-Signature"] ??
        headers["Apipay-Signature"] ??
        "";
      return verifyHmac(rawBody, signature, secrets);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let payload: ApipayWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as ApipayWebhookPayload;
      } catch {
        return null;
      }

      // ApiPay signals incoming transfers via 'transaction.in'. Anything else
      // (e.g. the deprecated 'transaction.out') doesn't credit any tenant.
      if (payload.event !== "transaction.in") return null;
      const data = payload.data;
      if (!data?.transactionId) return null;

      const orderId = extractOrderId(data.content ?? "");
      if (!orderId) return null;

      if (data.amount === undefined) return null;
      const amountMicros = vndToMicrosString(data.amount);
      if (amountMicros === null) return null;

      return {
        eventId: `apipay:${data.transactionId}`,
        type: "payment.completed",
        providerRef: orderId,
        amountMicros,
        currencyCode: "VND",
        metadata: {
          apipayTransactionId: data.transactionId,
          referenceCode: data.referenceCode,
          gateway: data.gateway,
          bankAccountPublicId: data.bankAccountPublicId,
          amount: data.amount,
        },
      };
    },

    async refund(_input: RefundInput): Promise<RefundResult> {
      return {
        state: "unsupported",
        error: {
          providerCode: "APIPAY_REFUND_UNSUPPORTED",
          message:
            "ApiPay (bank transfer) refunds are one-way and cannot be reversed via API. Use POST /admin/billing/ledger/adjust to record a manual debit, then transfer funds back to customer manually.",
        },
      };
    },

    /**
     * Every COMPLETED payment request in the window, following pages to the
     * end. The list filters by creation date; a checkout expires after 30
     * minutes, so a request created in the window settles in it too.
     *
     * The loop stops on a short page (true regardless of how paging is
     * spelled) and refuses to run past a hard ceiling, so a `page` parameter
     * that is silently ignored produces a loud failure instead of an infinite
     * loop.
     */
    async fetchTransactions(window: {
      since: Date;
      until?: Date;
    }): Promise<readonly ProviderTxnRecord[]> {
      const dateFrom = window.since.toISOString();
      const dateTo = (window.until ?? new Date()).toISOString();

      const records: ProviderTxnRecord[] = [];
      let page = 1;
      let sawFullPage = true;

      while (sawFullPage && page <= MAX_LIST_PAGES) {
        const params = new URLSearchParams({
          status: "COMPLETED",
          page: String(page),
          limit: String(FETCH_PAGE_LIMIT),
          dateFrom,
          dateTo,
        });

        const res = await fetcher(`${baseUrl}/v1/client/payment-requests?${params.toString()}`, {
          method: "GET",
          headers: { Authorization: authHeader },
        });
        if (!res.ok) {
          // Throw rather than return the records gathered so far: a partial
          // list is indistinguishable from a complete one downstream, and
          // every payment on the pages not read would be reported as missing.
          throw new Error(`ApiPay list payment-requests failed: HTTP ${res.status}`);
        }
        const json = (await res.json()) as ApipayPaymentRequestListResponse;
        const rows = json.data?.data ?? [];

        for (const row of rows) {
          if (!row.content) continue;
          const orderId = extractOrderId(row.content);
          if (!orderId) continue;
          // amount is null when the merchant let the customer type the amount;
          // such a request carries no expected figure the reconciler can compare.
          if (row.amount === null || row.amount === undefined) continue;
          const amountMicros = vndToMicrosString(row.amount);
          if (amountMicros === null) continue;
          records.push({
            providerRef: orderId,
            amountMicros,
            currencyCode: "VND",
          });
        }

        sawFullPage = rows.length >= FETCH_PAGE_LIMIT;
        page += 1;
      }

      if (sawFullPage) {
        throw new Error(
          `ApiPay list payment-requests exceeded ${MAX_LIST_PAGES} pages for the window; narrow the reconciliation window`,
        );
      }

      return records;
    },
  };
}
