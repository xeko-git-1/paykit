/**
 * V2 subscription types — pass-through pattern.
 *
 * SubscriptionStatus covers all 8 Stripe subscription statuses (RT F3).
 * Adapter MUST map every Stripe status into this union; unknown values
 * fall back to 'unpaid' and emit STATUS_UNKNOWN log (RT F3).
 *
 * `incomplete_expired` and `paused` MUST NOT trigger ledger credit
 * (Phase 06 dispatcher rejects these).
 */
import type { CurrencyCode } from "../types/money.js";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "unpaid"
  | "incomplete_expired"
  | "paused";

export interface CreateSubscriptionInput {
  readonly customerId: string;
  readonly priceId: string;
  readonly paykitTenantId: string;
  readonly trialDays?: number;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, string>;
}

export interface SubscriptionResult {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date;
  readonly customerId: string;
  readonly priceId: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly latestInvoiceId?: string;
  readonly currencyCode: CurrencyCode;
  readonly lastEventCreated: Date;
}

export interface CancelSubscriptionInput {
  readonly subscriptionId: string;
  readonly atPeriodEnd: boolean;
  readonly idempotencyKey?: string;
}

export interface UpgradeSubscriptionInput {
  readonly subscriptionId: string;
  readonly newPriceId: string;
  readonly idempotencyKey?: string;
}
