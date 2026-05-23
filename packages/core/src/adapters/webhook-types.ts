/**
 * NormalizedWebhookEvent — uniform shape adapters emit from parseWebhookPayload.
 *
 * Server-level webhook handler reads this; never touches provider-raw payload.
 * `metadata` carries adapter-specific raw fields (Stripe session id, Momo
 * resultCode, ZaloPay return_code, etc.) for audit + reconciliation.
 *
 * Returns `null` when payload is for an event the adapter doesn't credit/debit
 * (e.g., transferType='out' for SePay; non-paid Stripe Checkout).
 */
export type WebhookEventType =
  | "payment.completed"
  | "payment.failed"
  | "payment.expired"
  | "payment.refunded"
  | "unknown";

export interface NormalizedWebhookEvent {
  readonly eventId: string;
  readonly type: WebhookEventType;
  readonly providerRef: string;
  readonly amountMicros?: string;
  readonly currencyCode?: string;
  readonly refundAmountMicros?: string;
  readonly metadata: Record<string, unknown>;
}
