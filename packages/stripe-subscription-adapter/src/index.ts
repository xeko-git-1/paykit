/**
 * @vibecc/paykit-stripe-subscription — V2 Stripe Subscription adapter.
 *
 * Implements SubscriptionAdapter from @vibecc/paykit core. Coexists with
 * V1.5 @vibecc/paykit-stripe (one-off Checkout); register both in the
 * same paykit instance.
 */
export {
  createStripeSubscriptionAdapter,
  type StripeSubscriptionAdapterConfig,
} from "./adapter.js";
export {
  getHandledEventTypes,
  isHandledEventType,
  mapEvent,
} from "./webhook-events.js";
export { mapStripeStatus, type MapStatusOutcome } from "./status-mapper.js";

export const PAYKIT_STRIPE_SUBSCRIPTION_VERSION = "0.2.0-alpha.1";
