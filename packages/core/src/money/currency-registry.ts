/**
 * The currency registry — one place that knows how many minor-unit digits each
 * supported currency has, so amount→micros conversion stops being a per-currency
 * function that every new currency has to clone.
 *
 * Paykit's storage convention is unchanged: 1 major unit = 1_000_000 micros for
 * EVERY currency, including zero-decimal ones. The exponent here governs only
 * what a caller-supplied amount may look like — JPY 100.5 names half a yen,
 * which does not exist, while USD 100.50 is fine and USD 100.505 is not.
 *
 * Widening the registry stays a deliberate act (see currency-codes.ts): a new
 * code needs a settled exponent AND an adapter that declares it in
 * `supportedCurrencies` before a payment in it can credit a wallet anyone reads.
 */

import type { CurrencyCode } from "../types/money.js";

export interface CurrencyInfo {
  readonly code: CurrencyCode;
  /**
   * ISO-4217 minor-unit digits: 2 for cent currencies, 0 for currencies whose
   * major unit is already the smallest one. This is a validation property, not
   * a storage one — micros precision is identical for every currency.
   */
  readonly exponent: 0 | 2;
  readonly name: string;
}

export const CURRENCY_REGISTRY: Readonly<Record<CurrencyCode, CurrencyInfo>> = {
  USD: { code: "USD", exponent: 2, name: "US Dollar" },
  EUR: { code: "EUR", exponent: 2, name: "Euro" },
  VND: { code: "VND", exponent: 0, name: "Vietnamese Dong" },
  JPY: { code: "JPY", exponent: 0, name: "Japanese Yen" },
  KRW: { code: "KRW", exponent: 0, name: "South Korean Won" },
};

/** Micros per major currency unit — identical for every currency by design. */
const MICROS_PER_UNIT = 1_000_000n;

/**
 * How far `amount * 10^exponent` may sit from a whole minor unit and still
 * count as one. Binary floating point cannot hold most decimal fractions
 * exactly — `19.99 * 100` is `1998.9999999999998` — so an exact integer test
 * would reject ordinary prices. The representation gap is around 1e-11 of a
 * minor unit, far below the 0.5 that separates a real fractional amount.
 */
const MINOR_UNIT_EPSILON = 1e-6;

export function currencyExponent(code: CurrencyCode): 0 | 2 {
  return CURRENCY_REGISTRY[code].exponent;
}

/**
 * Convert a caller-supplied amount in major units to micros, refusing anything
 * the currency cannot express instead of rounding it — a caller naming JPY
 * 100.5 or USD 1.005 is not charged an amount they never named.
 *
 * @throws {Error} when the amount is not finite, is negative, or names a
 *   fraction of the currency's smallest unit
 */
export function amountToMicros(code: CurrencyCode, amount: number): bigint {
  if (!Number.isFinite(amount)) {
    throw new Error(`${code} amount must be a finite number: ${amount}`);
  }
  if (amount < 0) {
    throw new Error(`${code} amount must be non-negative: ${amount}`);
  }
  const exponent = currencyExponent(code);
  if (exponent === 0) {
    if (!Number.isInteger(amount)) {
      throw new Error(
        `${code} amount must be integer (${code} has no fractional units): ${amount}`,
      );
    }
    return BigInt(amount) * MICROS_PER_UNIT;
  }
  const minorUnits = amount * 100;
  const wholeMinorUnits = Math.round(minorUnits);
  if (Math.abs(minorUnits - wholeMinorUnits) > MINOR_UNIT_EPSILON) {
    throw new Error(
      `${code} amount must be a whole number of cents (no fractional cents): ${amount}`,
    );
  }
  return BigInt(wholeMinorUnits) * (MICROS_PER_UNIT / 100n);
}

/**
 * Convert an amount a provider already expressed in the currency's minor units
 * (Stripe/Paddle-style integer cents, or whole yen for zero-decimal codes) to
 * micros. No rounding decision exists here — the input is already integral —
 * so a fractional input is a wire-contract violation and throws.
 */
export function minorUnitsToMicros(code: CurrencyCode, minorUnits: number): bigint {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(`${code} minor-unit amount must be an integer: ${minorUnits}`);
  }
  if (minorUnits < 0) {
    throw new Error(`${code} minor-unit amount must be non-negative: ${minorUnits}`);
  }
  const exponent = currencyExponent(code);
  const microsPerMinorUnit = exponent === 0 ? MICROS_PER_UNIT : MICROS_PER_UNIT / 100n;
  return BigInt(minorUnits) * microsPerMinorUnit;
}
