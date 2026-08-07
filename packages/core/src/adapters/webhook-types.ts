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
  /**
   * Provider-side payment identifier the refund API needs, when it differs from
   * `providerRef` (the checkout/webhook lookup key). NowPayments: providerRef is
   * order_id but the refund API keys on the numeric payment_id, which only
   * arrives in the completion IPN. The server persists this on payment.completed
   * so a later refund can supply the correct id. Omitted by providers that
   * refund by providerRef.
   */
  readonly providerPaymentId?: string;
  /**
   * The provider's own identifier for the refund this event reports.
   *
   * Required to process a refund correctly, and not interchangeable with
   * `providerRef`: `providerRef` names the PAYMENT, so keying a refund on it
   * makes every refund of one payment look like the same refund. The ledger is
   * unique on (provider, source_id, entry_type), so the second partial refund
   * then collides with the first and its balance move is skipped — the money
   * stays in the wallet while the caller sees success.
   *
   * Omitted only by providers that do not name their refunds. Such a refund
   * cannot be told apart from a redelivery of an earlier one, so the server
   * treats it as at most one refund per payment.
   */
  readonly providerRefundId?: string;
  readonly metadata: Record<string, unknown>;
}
