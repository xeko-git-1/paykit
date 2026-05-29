/**
 * NormalizedSubscriptionEvent — V2 webhook contract.
 *
 * Adapter parses Stripe events and emits this uniform shape.
 *
 * 10 event types (RT F1, Val S4 Q1):
 *   - 3 sub lifecycle: sub.created, sub.updated, sub.deleted
 *   - 2 invoice settle: invoice.paid (→ ledger credit), invoice.failed
 *   - 4 refund/dispute: charge.refunded, charge.dispute.created,
 *                       charge.dispute.funds_withdrawn, credit_note.created
 *   - 1 customer lifecycle: customer.deleted (cascade-cancel active subs)
 *
 * `eventCreatedAt` is Stripe's `created` timestamp — feeds the
 * last-write-wins predicate (RT F9) when webhooks arrive out of order.
 */
import type { SubscriptionStatus } from "./types.js";

export type SubscriptionEventType =
  | "sub.created"
  | "sub.updated"
  | "sub.deleted"
  | "invoice.paid"
  | "invoice.failed"
  | "charge.refunded"
  | "charge.dispute.created"
  | "charge.dispute.funds_withdrawn"
  | "credit_note.created"
  | "customer.deleted";

export interface NormalizedSubscriptionEvent {
  readonly eventId: string;
  readonly type: SubscriptionEventType;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly status?: SubscriptionStatus;
  readonly amountMicros?: string;
  readonly currencyCode?: string;
  readonly invoiceId?: string;
  readonly chargeId?: string;
  readonly refundAmountMicros?: string;
  readonly eventCreatedAt: Date;
  readonly metadata: Record<string, unknown>;
}
