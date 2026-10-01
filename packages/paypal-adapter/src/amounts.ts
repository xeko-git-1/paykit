/**
 * PayPal amount conversion. PayPal writes money as a decimal STRING in major
 * units ("50.00", or "1000" for zero-decimal JPY). Both directions stay in
 * bigint so no float rounding can enter an amount.
 */
import { type CurrencyCode, currencyExponent } from "@xeko-git-1/paykit";

/** Micros → PayPal `value`. Sub-minor-unit surplus is truncated, never rounded up. */
export function microsToPaypalValue(code: CurrencyCode, micros: bigint): string {
  if (currencyExponent(code) === 0) return (micros / 1_000_000n).toString();
  const cents = micros / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * PayPal `value` → micros string, or null for anything that is not a plain
 * non-negative decimal. Negative values (refund rows in Transaction Search)
 * are deliberately unreadable here: callers treat null as "not a payment".
 */
export function paypalValueToMicros(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  return (whole * 1_000_000n + fraction).toString();
}
