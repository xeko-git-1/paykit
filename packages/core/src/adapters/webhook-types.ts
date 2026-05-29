/**
 * NormalizedWebhookEvent — uniform shape adapters emit from parseWebhookPayload.
 *
 * Server-level webhook handler reads this; never touches provider-raw payload.
 * `metadata` carries adapter-specific raw fields (Stripe session id, Momo
 * resultCode, ZaloPay return_code, etc.) for audit + reconciliation.
 *
 * Returns `null` when payload is for an event the adapter doesn't credit/debit
 * (e.g., transferType='out' for SePay; non-paid Stripe Checkout).
 *
 * V3 (Val Session 1 D2 + D3) adds:
 *   - `payment.underpaid`     — customer paid less than charge total (e.g.
 *     Coinbase Commerce charge:resolved status=underpaid, NowPayments
 *     status=partially_paid). Audit row + metric, NO ledger move.
 *   - `payment.amount_mismatch` — webhook-reported amount drifts from stored
 *     transaction amount > 5 bps. status='quarantine', NO ledger move; admin
 *     reconciles via /admin/billing/ledger/adjust after off-chain check.
 */
export type WebhookEventType =
  | "payment.completed"
  | "payment.failed"
  | "payment.expired"
  | "payment.refunded"
  | "payment.underpaid"
  | "payment.amount_mismatch"
  | "unknown";

export interface NormalizedWebhookEvent {
  readonly eventId: string;
  readonly type: WebhookEventType;
  readonly providerRef: string;
  readonly amountMicros?: string;
  readonly currencyCode?: string;
  readonly refundAmountMicros?: string;
  /** V3 payment.underpaid + payment.amount_mismatch — original charge amount. */
  readonly expectedAmountMicros?: string;
  readonly metadata: Record<string, unknown>;
}
