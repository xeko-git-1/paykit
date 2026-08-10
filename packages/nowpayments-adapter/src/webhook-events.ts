/**
 * NowPayments IPN payment_status → paykit WebhookEventType mapping.
 *
 * Verified taxonomy (Phase 01 decision-log.md):
 *   waiting       → null (in-flight; awaiting payment)
 *   confirming    → null (in-flight; tx broadcast)
 *   confirmed     → null (in-flight; awaiting settlement)
 *   sending       → null (in-flight; gateway converting/sending USD)
 *   partially_paid → payment.underpaid (RT F5 — audit-only with actual+expected)
 *   finished      → payment.completed
 *   failed        → payment.failed
 *   refunded      → payment.refunded
 *   expired       → payment.expired
 *
 * Amount-drift detection (RT F6 carry-over): if payment_status='finished' but
 * `actually_paid` differs from stored `pay_amount` by > 5 bps, emit
 * payment.amount_mismatch instead of payment.completed → server quarantines
 * (Val D3) until admin reconciles.
 */
import type { NormalizedWebhookEvent, WebhookEventType } from "@xeko-git-1/paykit";

export interface NpIpnPayload {
  readonly payment_id?: number | string;
  readonly invoice_id?: number | string;
  readonly payment_status?: string;
  readonly pay_address?: string;
  readonly price_amount?: number | string;
  readonly price_currency?: string;
  readonly pay_amount?: number | string;
  readonly actually_paid?: number | string;
  readonly pay_currency?: string;
  readonly order_id?: string;
  readonly order_description?: string;
  readonly outcome_amount?: number | string;
  readonly outcome_currency?: string;
  readonly purchase_id?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

const AMOUNT_DRIFT_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

export function mapStatusToEventType(status: string | undefined): WebhookEventType | null {
  switch (status) {
    case "finished":
      return "payment.completed";
    case "failed":
      return "payment.failed";
    case "expired":
      return "payment.expired";
    case "refunded":
      return "payment.refunded";
    case "partially_paid":
      return "payment.underpaid";
    case "waiting":
    case "confirming":
    case "confirmed":
    case "sending":
      return null;
    default:
      return null;
  }
}

function priceMicros(amount: number | string | undefined): string | undefined {
  if (amount === undefined || amount === null || amount === "") return undefined;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return BigInt(Math.round(n * 1_000_000)).toString();
}

function exceedsDriftThreshold(expected: bigint, actual: bigint): boolean {
  if (expected === 0n) return actual !== 0n;
  const diff = expected > actual ? expected - actual : actual - expected;
  return diff * BPS_DENOMINATOR > expected * AMOUNT_DRIFT_BPS;
}

export function parseNpIpn(payload: NpIpnPayload): NormalizedWebhookEvent | null {
  if (!payload.order_id) return null;

  const baseType = mapStatusToEventType(payload.payment_status);
  if (baseType === null) return null;

  const expected = priceMicros(payload.price_amount);
  const actually = priceMicros(payload.actually_paid ?? payload.pay_amount);

  let type: WebhookEventType = baseType;
  if (
    baseType === "payment.completed" &&
    expected !== undefined &&
    actually !== undefined &&
    exceedsDriftThreshold(BigInt(expected), BigInt(actually))
  ) {
    type = "payment.amount_mismatch";
  }

  const eventId = `nowpayments:${payload.order_id}:${payload.payment_id ?? "0"}:${payload.payment_status ?? "?"}`;
  const currencyCode =
    typeof payload.price_currency === "string" ? payload.price_currency.toUpperCase() : "USD";

  // payment.refunded must carry refundAmountMicros or the webhook-router refund
  // case early-returns and the ledger debit is never written. Reverse exactly
  // the credited amount (actually_paid, same source as payment.completed),
  // falling back to price_amount. Full-refund only; partial-refund IPNs deferred.
  const refundAmountMicros = type === "payment.refunded" ? (actually ?? expected) : undefined;

  // NowPayments' refund API keys on its own numeric payment_id, not order_id.
  // Surface it so the server can persist it on payment.completed for later refunds.
  const providerPaymentId =
    payload.payment_id !== undefined && payload.payment_id !== null
      ? String(payload.payment_id)
      : undefined;

  return {
    eventId,
    type,
    providerRef: payload.order_id,
    ...(actually !== undefined ? { amountMicros: actually } : {}),
    ...(expected !== undefined ? { expectedAmountMicros: expected } : {}),
    ...(refundAmountMicros !== undefined ? { refundAmountMicros } : {}),
    ...(providerPaymentId !== undefined ? { providerPaymentId } : {}),
    currencyCode,
    metadata: {
      paymentId: payload.payment_id,
      invoiceId: payload.invoice_id,
      paymentStatus: payload.payment_status,
      payCurrency: payload.pay_currency,
      payAmount: payload.pay_amount,
      actuallyPaid: payload.actually_paid,
      outcomeAmount: payload.outcome_amount,
      outcomeCurrency: payload.outcome_currency,
      purchaseId: payload.purchase_id,
      payAddress: payload.pay_address,
    },
  };
}
