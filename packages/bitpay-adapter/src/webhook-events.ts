/**
 * BitPay invoice status → paykit WebhookEventType mapping.
 *
 * BitPay invoice lifecycle (authoritative status fetched via fetch-back, since
 * BitPay does NOT sign its IPNs — the POSTed body is only a trigger):
 *   new        → null (awaiting payment)
 *   paid       → null (received on-chain, not yet confirmed — in-flight)
 *   confirmed  → payment.completed (enough blockchain confirmations; safe credit)
 *   complete   → payment.completed (settled to merchant; idempotent no-op if
 *                already credited at 'confirmed' — UNIQUE(provider,sourceId,
 *                entry_type) + router row.status='pending' gate dedup it)
 *   expired    → payment.expired
 *   invalid    → payment.failed
 *
 * exceptionStatus (orthogonal to status):
 *   paidPartial → payment.underpaid (audit-only; BitPay auto-refunds buyer)
 *   paidOver    → credit invoice price normally (BitPay auto-refunds the excess
 *                 to the buyer, so the merchant settles exactly `price`)
 *
 * Amount-drift (parity with NowPayments Val D3): if a settled invoice's paid
 * amount drifts > 5 bps from the invoice price, emit payment.amount_mismatch so
 * the server quarantines instead of crediting.
 */
import type { NormalizedWebhookEvent, WebhookEventType } from "@xeko-git-1/paykit";

export interface BitpayInvoice {
  readonly id?: string;
  readonly orderId?: string;
  readonly status?: string;
  readonly exceptionStatus?: string | boolean;
  readonly price?: number | string;
  readonly currency?: string;
  /** Amount actually paid, in invoice currency (BitPay echoes under several keys). */
  readonly amountPaid?: number | string;
  readonly displayAmountPaid?: number | string;
}

const AMOUNT_DRIFT_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

export function mapInvoiceStatusToEventType(status: string | undefined): WebhookEventType | null {
  switch (status) {
    case "confirmed":
    case "complete":
      return "payment.completed";
    case "expired":
      return "payment.expired";
    case "invalid":
      return "payment.failed";
    case "new":
    case "paid":
      return null;
    default:
      return null;
  }
}

/**
 * BitPay decimal amount (number or numeric string) → integer micros string.
 * Returns undefined for absent/unparseable/negative input so callers can skip
 * rather than move the ledger by a guessed amount. Shared with refund
 * resolution: both paths must derive micros identically or a refund could debit
 * a different magnitude than the credit it reverses.
 */
export function amountToMicros(amount: number | string | undefined): string | undefined {
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

/**
 * Build a NormalizedWebhookEvent from an authoritative BitPay invoice (the one
 * fetched back from the API, never the untrusted IPN body). Returns null for
 * in-flight / unrecognised statuses (skip).
 */
export function invoiceToEvent(invoice: BitpayInvoice): NormalizedWebhookEvent | null {
  if (!invoice.orderId) return null;

  const baseType = mapInvoiceStatusToEventType(invoice.status);
  if (baseType === null) return null;

  const expected = amountToMicros(invoice.price);
  const actually = amountToMicros(invoice.amountPaid ?? invoice.displayAmountPaid);

  let type: WebhookEventType = baseType;
  if (baseType === "payment.completed" && invoice.exceptionStatus === "paidPartial") {
    type = "payment.underpaid";
  } else if (
    baseType === "payment.completed" &&
    expected !== undefined &&
    actually !== undefined &&
    exceedsDriftThreshold(BigInt(expected), BigInt(actually))
  ) {
    type = "payment.amount_mismatch";
  }

  const currencyCode =
    typeof invoice.currency === "string" ? invoice.currency.toUpperCase() : "USD";

  return {
    eventId: `bitpay:${invoice.orderId}:${invoice.id ?? "0"}:${invoice.status ?? "?"}`,
    type,
    providerRef: invoice.orderId,
    ...(actually !== undefined ? { amountMicros: actually } : {}),
    ...(expected !== undefined ? { expectedAmountMicros: expected } : {}),
    currencyCode,
    metadata: {
      invoiceId: invoice.id,
      status: invoice.status,
      exceptionStatus: invoice.exceptionStatus,
      price: invoice.price,
      amountPaid: invoice.amountPaid ?? invoice.displayAmountPaid,
    },
  };
}
