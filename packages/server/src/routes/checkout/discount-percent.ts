/**
 * Discount percent validation and the percent → effective-amount math.
 *
 * Split out from the consume lifecycle because the ORDER matters: the percent
 * has to be proven usable BEFORE the discount is consumed. Consuming first and
 * validating after means an out-of-range percent leaves the redemption spent
 * while the customer is charged full price — the reservation is gone and
 * nothing is owed back.
 */

/** A percent that is safe to turn into an effective amount. */
export interface ValidDiscountPercent {
  readonly percent: number;
  /** Percent in basis points, 0..10000. */
  readonly bps: number;
}

/**
 * Validate a resolver-supplied percent.
 *
 * NaN must be rejected explicitly: `NaN < 0` and `NaN > 100` are both false, so
 * a bare range check lets it through to `BigInt(10000 - NaN)`, which throws.
 *
 * Basis points rather than a rounded percent keeps fractional discounts exact —
 * rounding the percent itself would turn 12.5% into 13% and 0.4% into 0%,
 * charging an amount nobody agreed to.
 */
export function validateDiscountPercent(percent: number): ValidDiscountPercent | null {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return { percent, bps: Math.round(percent * 100) };
}

/**
 * Apply a validated percent to an amount. The `+ 5000n` rounds the result to the
 * nearest micro rather than truncating toward zero.
 */
export function effectiveMicrosFor(amountMicros: bigint, valid: ValidDiscountPercent): bigint {
  return (amountMicros * BigInt(10000 - valid.bps) + 5000n) / 10000n;
}
