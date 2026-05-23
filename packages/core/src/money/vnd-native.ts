/**
 * VND-native micros conversion.
 *
 * VND has no fractional dong → must be integer.
 * 1 VND = 1_000_000 micros (paykit's universal precision).
 *
 * Explicit non-goal: synthetic FX (e.g. VibeCC's VND × 25 → "USD micros") which
 * couples paykit ledger to a hardcoded exchange rate. Paykit stores VND-native
 * with currency_code='VND'. Reconciliation compares per-currency without FX.
 */

export function vndToMicros(amountVnd: number): bigint {
  if (!Number.isInteger(amountVnd)) {
    throw new Error(`VND amount must be integer (no fractional dong): ${amountVnd}`);
  }
  if (amountVnd < 0) {
    throw new Error(`VND amount must be non-negative: ${amountVnd}`);
  }
  return BigInt(amountVnd) * 1_000_000n;
}
