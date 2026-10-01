/**
 * @xeko-git-1/paykit-paypal — adapter for PayPal Orders v2 checkouts.
 *
 * Notable: the adapter captures on CHECKOUT.ORDER.APPROVED; webhooks are
 * authenticated by fetching the resource back from PayPal's API, not by
 * signature; refunds go through the capture refund API with PayPal-Request-Id
 * idempotency; reconciliation uses Transaction Search, which lags real time.
 * Not yet live-verified against a PayPal sandbox account.
 */
export { createPaypalAdapter, type PaypalAdapterConfig } from "./adapter.js";
export { microsToPaypalValue, paypalValueToMicros } from "./amounts.js";

export const PAYKIT_PAYPAL_VERSION = "0.3.0-rc.0";
