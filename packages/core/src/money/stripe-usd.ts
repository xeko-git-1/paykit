/**
 * Stripe USD amount → micros conversion.
 *
 * Stripe `amount_total` for USD is in cents (smallest currency unit).
 * Paykit ledger uses micros (1/1_000_000 of a unit), so cents × 10_000 = micros.
 *
 * Multi-currency support deferred to V2 (zero-decimal currency table).
 * VND is handled separately via `vndToMicros` (1 VND = 1_000_000 micros).
 */

import { UnsupportedCurrencyError } from "../errors/index.js";

export function stripeUsdAmountToMicros(amountTotal: number, currency: string): bigint {
  if (currency.toLowerCase() !== "usd") {
    throw new UnsupportedCurrencyError(
      `Stripe currency '${currency}' not supported (USD only in V1)`,
    );
  }
  return BigInt(Math.round(amountTotal)) * 10_000n;
}
