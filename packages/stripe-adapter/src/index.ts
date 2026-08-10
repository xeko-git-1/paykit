/**
 * @xeko-git-1/paykit-stripe — V1.5 adapter for Stripe one-time payments.
 *
 * Implements PaymentProviderAdapter from @xeko-git-1/paykit core. Wraps existing
 * V1 StripeClient logic; webhook signature rotation preserved (string | string[]).
 *
 * V2 will add Stripe Subscription via separate adapter or extend this one.
 */
export { createStripeAdapter, type StripeAdapterConfig } from "./adapter.js";

export const PAYKIT_STRIPE_VERSION = "0.1.5-alpha.1";
