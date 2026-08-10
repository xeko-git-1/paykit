/**
 * Cryptomus webhook payment_status → paykit WebhookEventType mapping.
 *
 * Cryptomus payment lifecycle (status field on the webhook body):
 *   paid            → payment.completed (paid exactly)
 *   paid_over       → payment.completed (customer overpaid; merchant settles the
 *                     invoice amount, Cryptomus keeps the surplus in the balance)
 *   wrong_amount    → payment.underpaid (customer paid less than invoiced;
 *                     audit-only, NO ledger move — admin reconciles)
 *   confirm_check   → null (funds seen on-chain, awaiting confirmations)
 *   check           → null (awaiting payment)
 *   process         → null (in progress)
 *   cancel          → payment.failed
 *   fail            → payment.failed
 *   system_fail     → payment.failed
 *   wrong_amount_waiting → null (partial received, still waiting for the rest)
 *   refund_process  → null (refund in progress; terminal refund IPN carries a
 *                     refund status handled separately)
 *   refund_paid     → payment.refunded
 *
 * Amount-drift (parity with NowPayments / BitPay): when a paid invoice's
 * `payment_amount_usd` drifts > 5 bps from the invoiced `amount`, emit
 * payment.amount_mismatch so the server quarantines instead of crediting.
 *
 * providerRef = `order_id` (the merchant reference paykit sets to its
 * transactionId), NOT Cryptomus' `uuid`. The order_id round-trips in every
 * webhook, so the router's (provider, provider_ref) lookup matches the row.
 */
import type { NormalizedWebhookEvent, WebhookEventType } from "@xeko-git-1/paykit";

export interface CryptomusWebhookPayload {
  readonly type?: string;
  readonly uuid?: string;
  readonly order_id?: string;
  readonly status?: string;
  readonly amount?: string;
  readonly payment_amount?: string;
  readonly payment_amount_usd?: string;
  readonly merchant_amount?: string;
  readonly currency?: string;
  readonly payer_currency?: string;
  readonly network?: string;
  readonly txid?: string;
  readonly is_final?: boolean;
  readonly sign?: string;
}

const AMOUNT_DRIFT_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

export function mapStatusToEventType(status: string | undefined): WebhookEventType | null {
  switch (status) {
    case "paid":
    case "paid_over":
      return "payment.completed";
    case "wrong_amount":
      return "payment.underpaid";
    case "refund_paid":
      return "payment.refunded";
    case "cancel":
    case "fail":
    case "system_fail":
      return "payment.failed";
    case "check":
    case "confirm_check":
    case "process":
    case "wrong_amount_waiting":
    case "refund_process":
      return null;
    default:
      return null;
  }
}

function usdMicros(amount: string | undefined): string | undefined {
  if (amount === undefined || amount === null || amount === "") return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return BigInt(Math.round(n * 1_000_000)).toString();
}

function exceedsDriftThreshold(expected: bigint, actual: bigint): boolean {
  if (expected === 0n) return actual !== 0n;
  const diff = expected > actual ? expected - actual : actual - expected;
  return diff * BPS_DENOMINATOR > expected * AMOUNT_DRIFT_BPS;
}

export function parseCryptomusWebhook(
  payload: CryptomusWebhookPayload,
): NormalizedWebhookEvent | null {
  if (!payload.order_id) return null;

  const baseType = mapStatusToEventType(payload.status);
  if (baseType === null) return null;

  // Invoiced amount (USD) vs what the customer actually paid (USD).
  const expected = usdMicros(payload.amount);
  const actually = usdMicros(payload.payment_amount_usd ?? payload.merchant_amount);

  let type: WebhookEventType = baseType;
  if (
    baseType === "payment.completed" &&
    expected !== undefined &&
    actually !== undefined &&
    exceedsDriftThreshold(BigInt(expected), BigInt(actually))
  ) {
    type = "payment.amount_mismatch";
  }

  // A refund reverses exactly what was credited (the invoiced amount, matching
  // the payment.completed credit). Without refundAmountMicros the webhook-router
  // refund case early-returns and the ledger debit is never written.
  const refundAmountMicros = type === "payment.refunded" ? (expected ?? actually) : undefined;

  const eventId = `cryptomus:${payload.order_id}:${payload.uuid ?? "0"}:${payload.status ?? "?"}`;
  const currencyCode = "USD";

  return {
    eventId,
    type,
    providerRef: payload.order_id,
    ...(actually !== undefined ? { amountMicros: actually } : {}),
    ...(expected !== undefined ? { expectedAmountMicros: expected } : {}),
    ...(refundAmountMicros !== undefined ? { refundAmountMicros } : {}),
    currencyCode,
    metadata: {
      uuid: payload.uuid,
      status: payload.status,
      network: payload.network,
      payerCurrency: payload.payer_currency,
      txid: payload.txid,
      paymentAmount: payload.payment_amount,
      merchantAmount: payload.merchant_amount,
    },
  };
}
