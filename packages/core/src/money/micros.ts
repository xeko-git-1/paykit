/**
 * Canonical micros parse/format. Every money column in paykit stores an
 * INTEGER number of micros (1/1_000_000 of a currency unit) and round-trips
 * through `pg` as a decimal string.
 *
 * `parseMicros` is the single entry point for string → bigint. It REJECTS a
 * non-zero fractional part instead of truncating it: truncation loses money
 * silently, and a fractional micro can only come from a defect (no write path
 * produces one) or from data written before the columns became scale-0.
 *
 * A fractional part of all zeros ("1000000.000000") is accepted and dropped —
 * that is how a scale-6 numeric column renders an integer value, so old rows
 * and old snapshots stay readable.
 *
 * `formatMicros` is the inverse, for writing a bigint back to a money column.
 */

import { InvalidMicrosError } from "../errors/index.js";

/** Integer, optional sign, optional fractional tail. No exponent, no spaces. */
const MICROS_PATTERN = /^(-?)(\d+)(?:\.(\d*))?$/;

/**
 * Parse a micros column value into an exact bigint.
 *
 * @throws {InvalidMicrosError} on a malformed value or a non-zero fraction.
 */
export function parseMicros(value: string): bigint {
  const match = MICROS_PATTERN.exec(value);
  if (match === null) {
    throw new InvalidMicrosError(`Micros value is not a decimal integer: ${JSON.stringify(value)}`);
  }
  const [, sign = "", digits = "0", fraction = ""] = match;
  if (fraction.length > 0 && /[^0]/.test(fraction)) {
    // Truncating here would silently move money. Surface it instead.
    throw new InvalidMicrosError(
      `Micros value has a fractional part; micros must be whole: ${JSON.stringify(value)}`,
    );
  }
  return BigInt(`${sign}${digits}`);
}

/** Format an exact micros amount for a money column. */
export function formatMicros(micros: bigint): string {
  return micros.toString();
}

/**
 * Legacy name for `parseMicros`, kept because it is part of the public barrel
 * and is imported by adapters. Same strict semantics.
 */
export function microsStringToBigInt(microsStr: string): bigint {
  return parseMicros(microsStr);
}

/**
 * Lossy view of a micros value for display and metric counters ONLY. Never use
 * for a ledger write — doubles cannot represent the full micros range.
 */
export function microsStringToNumber(microsStr: string): number {
  const n = Number(microsStr);
  if (!Number.isFinite(n)) throw new Error(`Invalid micros: ${microsStr}`);
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Micros exceeds JS safe int: ${microsStr}`);
  }
  return n;
}
