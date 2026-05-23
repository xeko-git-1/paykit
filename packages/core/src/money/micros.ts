/**
 * Money micros conversions for paykit ledger.
 *
 * Postgres `numeric(20,6)` round-trips as a decimal string (e.g. "1000000.000000").
 * `BigInt("1000000.000000")` THROWS — must split on '.' first.
 *
 * `microsStringToBigInt` is the canonical helper for ledger writes (preserves precision).
 * `microsStringToNumber` is for display / metric counters only — caps at MAX_SAFE_INTEGER.
 */

export function microsStringToBigInt(microsStr: string): bigint {
  const integerPart = microsStr.split(".")[0] ?? "0";
  if (integerPart === "" || integerPart === "-") return 0n;
  return BigInt(integerPart);
}

export function microsStringToNumber(microsStr: string): number {
  const n = Number(microsStr);
  if (!Number.isFinite(n)) throw new Error(`Invalid micros: ${microsStr}`);
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Micros exceeds JS safe int: ${microsStr}`);
  }
  return n;
}
