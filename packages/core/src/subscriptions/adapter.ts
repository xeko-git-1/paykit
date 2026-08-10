/**
 * SubscriptionAdapter — V2 contract. Parallel to V1.5 PaymentProviderAdapter.
 * Implemented by @xeko-git-1/paykit-stripe-subscription. 9 methods (RT 15f: no displayName).
 *
 * Lifecycle:
 *   - subscribe / cancel / upgrade: provider HTTP, idempotent via input.idempotencyKey
 *   - listForCustomer / getById:    read-only provider list/retrieve
 *   - verifyWebhookSignature:       pure
 *   - parseSubscriptionEvent:       pure (returns null when event type unhandled)
 *   - syncSubscription:             reconciler entrypoint — adapter-side fetch
 *                                   used to repair cache drift
 */
import type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  SubscriptionResult,
  UpgradeSubscriptionInput,
} from "./types.js";
import type { NormalizedSubscriptionEvent } from "./webhook-types.js";

export interface SubscriptionAdapter {
  readonly id: string;

  subscribe(input: CreateSubscriptionInput): Promise<SubscriptionResult>;

  cancel(input: CancelSubscriptionInput): Promise<SubscriptionResult>;

  upgrade(input: UpgradeSubscriptionInput): Promise<SubscriptionResult>;

  listForCustomer(customerId: string): Promise<readonly SubscriptionResult[]>;

  getById(subscriptionId: string): Promise<SubscriptionResult | null>;

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean;

  parseSubscriptionEvent(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedSubscriptionEvent | null;

  syncSubscription(subscriptionId: string): Promise<SubscriptionResult | null>;
}
