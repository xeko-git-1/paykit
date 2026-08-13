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

import { amountToMicros } from "./currency-registry.js";

export function vndToMicros(amountVnd: number): bigint {
  return amountToMicros("VND", amountVnd);
}
