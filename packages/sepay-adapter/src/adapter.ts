/**
 * createSepayAdapter — wraps SePay (VietQR) as PaymentProviderAdapter.
 *
 * V1.5 contract:
 * - id: 'sepay'
 * - supportedCurrencies: ['VND']
 * - checkoutMode: 'qr'
 * - createCheckout: builds VietQR URL with HMAC-anchored description
 * - parseWebhookPayload: handles transferType='in' only; null otherwise (skip)
 * - refund: returns state='unsupported' with helpful pointer to /admin/billing/ledger/adjust
 * - fetchTransactions: consumer-provided pull function (SePay HTTP API varies per merchant tenant)
 */
import { createHmac } from "node:crypto";
import {
  AmountMismatchError,
  type CheckoutResult,
  type CreateCheckoutInput,
  type NormalizedWebhookEvent,
  type PaymentProviderAdapter,
  type ProviderTxnRecord,
  type RefundInput,
  type RefundResult,
  microsStringToBigInt,
  vndToMicros,
} from "@vibecc/paykit";

export interface SepayAdapterConfig {
  readonly id?: string;
  readonly apiKey: string;
  readonly secretKey: string | readonly string[];
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankBin: string;
  readonly brandPrefix?: string;
  readonly environment?: "sandbox" | "production";
  /** Consumer-provided fetcher for reconciliation (SePay HTTP API per merchant). */
  readonly transactionFetcher?: (window: { since: Date; until?: Date }) => Promise<
    readonly { id: string; orderId: string; transferAmount: number }[]
  >;
}

const QR_EXPIRY_MS = 30 * 60 * 1000;

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

interface SepayWebhookPayload {
  readonly id: string;
  readonly content: string;
  readonly description: string;
  readonly transferType: "in" | "out";
  readonly transferAmount: number;
  readonly referenceCode: string;
}

export function createSepayAdapter(config: SepayAdapterConfig): PaymentProviderAdapter {
  const id = config.id ?? "sepay";
  const brandPrefix = config.brandPrefix ?? "PAYKIT";
  const secrets = Array.isArray(config.secretKey)
    ? (config.secretKey as readonly string[])
    : [config.secretKey as string];

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
    displayName: "SePay",
    supportedCurrencies: ["VND"],
    checkoutMode: "qr",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
      if (input.currencyCode !== "VND") {
        throw new Error(`SePay adapter supports VND only; received '${input.currencyCode}'`);
      }
      // amountMicros (BigInt VND-native) → VND for VietQR (1 VND = 1_000_000 micros)
      const amountVnd = Number(input.amountMicros / 1_000_000n);
      const description = `${brandPrefix} ${input.transactionId}`;
      const qrUrl = `https://img.vietqr.io/image/${config.bankBin}-${config.accountNumber}-qr_only.png?amount=${amountVnd}&addInfo=${encodeURIComponent(description)}&accountName=${encodeURIComponent(config.accountName)}`;
      return {
        webUrl: qrUrl,
        qrUrl,
        expiresAt: new Date(Date.now() + QR_EXPIRY_MS),
      };
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      const signature = headers["x-sepay-signature"] ?? headers["X-Sepay-Signature"] ?? "";
      return verifyHmac(rawBody, signature, secrets);
    },

    parseWebhookPayload(
      rawBody: string,
      _headers: Record<string, string>,
    ): NormalizedWebhookEvent | null {
      let payload: SepayWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as SepayWebhookPayload;
      } catch {
        return null;
      }

      // SePay sends both 'in' (incoming = credit) and 'out' (outgoing) transfers.
      // Adapter handles incoming only — outgoing transfers don't credit any tenant.
      if (payload.transferType !== "in") return null;

      const orderId = extractOrderId(payload.content ?? payload.description ?? "");
      if (!orderId) return null;

      // VND-native: amountMicros = transferAmount × 1_000_000
      const amountMicros = (BigInt(payload.transferAmount) * 1_000_000n).toString();

      return {
        eventId: `sepay:${payload.id}`,
        type: "payment.completed",
        providerRef: orderId,
        amountMicros,
        currencyCode: "VND",
        metadata: {
          sepayEventId: payload.id,
          referenceCode: payload.referenceCode,
          transferAmount: payload.transferAmount,
        },
      };
    },

    async refund(_input: RefundInput): Promise<RefundResult> {
      return {
        state: "unsupported",
        error: {
          providerCode: "SEPAY_REFUND_UNSUPPORTED",
          message:
            "SePay (bank transfer) refunds are one-way and cannot be reversed via API. Use POST /admin/billing/ledger/adjust to record a manual debit, then transfer funds back to customer manually.",
        },
      };
    },

    async fetchTransactions(window): Promise<readonly ProviderTxnRecord[]> {
      if (!config.transactionFetcher) return [];
      const txns = await config.transactionFetcher(window);
      return txns.map<ProviderTxnRecord>((t) => ({
        providerRef: t.orderId,
        amountMicros: (BigInt(t.transferAmount) * 1_000_000n).toString(),
        currencyCode: "VND",
      }));
    },
  };
}

// Re-export AmountMismatchError + microsStringToBigInt for adapter consumers
// who want to perform underpayment guard at server level.
export { AmountMismatchError, microsStringToBigInt, vndToMicros };
