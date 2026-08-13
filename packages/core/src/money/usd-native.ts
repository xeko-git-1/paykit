/**
 * USD amount → micros conversion.
 *
 * The dollar figure a caller sends is not the smallest unit of its own currency,
 * so turning it into micros needs a rounding decision, and that decision was
 * being made independently in three routers as
 * `BigInt(Math.round(amountUsd * 100)) * 10_000n`. Rounding silently is the
 * problem: `1.005` becomes either 100 or 101 cents depending on how the float
 * landed, and the caller is charged an amount they never named with nothing in
 * the response saying so.
 *
 * So an amount that cannot be expressed in cents is rejected rather than
 * rounded, matching `vndToMicros` — which already refuses fractional dong
 * instead of truncating them.
 *
 * `stripeUsdAmountToMicros` is the other direction of the same conversion and
 * stays separate: it takes an amount Stripe already expressed in cents, so it
 * has no rounding decision to make.
 */

import { amountToMicros } from "./currency-registry.js";

/**
 * Convert a USD amount in dollars to micros.
 *
 * Since the currency registry, this is the generic conversion pinned to "USD";
 * it stays exported because three routers and the public API already name it.
 *
 * @param amountUsd dollars; must be finite, non-negative, and a whole number of cents
 * @throws {Error} when the amount is not finite, is negative, or names a
 *   fraction of a cent
 */
export function usdToMicros(amountUsd: number): bigint {
  return amountToMicros("USD", amountUsd);
}
