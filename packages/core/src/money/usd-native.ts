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

/** Micros per cent: 1 USD = 100 cents = 1_000_000 micros. */
const MICROS_PER_CENT = 10_000n;

/**
 * How far `amountUsd * 100` may sit from a whole cent and still count as one.
 *
 * Binary floating point cannot hold most decimal fractions exactly — `19.99 * 100`
 * is `1998.9999999999998`, not `1999` — so an exact integer test would reject
 * ordinary prices. The gap it leaves is around 1e-11 of a cent, far below the
 * 0.5 that separates a real fractional amount like `1.005` from a representation
 * artefact.
 */
const CENT_EPSILON = 1e-6;

/**
 * Convert a USD amount in dollars to micros.
 *
 * @param amountUsd dollars; must be finite, non-negative, and a whole number of cents
 * @throws {Error} when the amount is not finite, is negative, or names a
 *   fraction of a cent
 */
export function usdToMicros(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd)) {
    throw new Error(`USD amount must be a finite number: ${amountUsd}`);
  }
  if (amountUsd < 0) {
    throw new Error(`USD amount must be non-negative: ${amountUsd}`);
  }
  const cents = amountUsd * 100;
  const wholeCents = Math.round(cents);
  if (Math.abs(cents - wholeCents) > CENT_EPSILON) {
    throw new Error(
      `USD amount must be a whole number of cents (no fractional cents): ${amountUsd}`,
    );
  }
  return BigInt(wholeCents) * MICROS_PER_CENT;
}
