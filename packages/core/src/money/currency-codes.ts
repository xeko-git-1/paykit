/**
 * The currency allow-list paykit validates against, kept deliberately identical
 * to the `CurrencyCode` union so the type and the runtime guard cannot drift.
 *
 * Widening this set is a deliberate act: every currency here must have a
 * settled micros convention (paykit stores 1 unit = 1_000_000 micros for every
 * currency, including zero-decimal ones like VND) and an adapter that declares
 * it in `supportedCurrencies`. Adding a code without both is how a payment ends
 * up crediting a wallet nobody reads.
 */

import { InvalidCurrencyCodeError } from "../errors/index.js";
import type { CurrencyCode } from "../types/money.js";

export const SUPPORTED_CURRENCY_CODES = ["USD", "VND"] as const satisfies readonly CurrencyCode[];

const SUPPORTED = new Set<string>(SUPPORTED_CURRENCY_CODES);

export function isSupportedCurrencyCode(value: string): value is CurrencyCode {
  return SUPPORTED.has(value);
}

/**
 * Narrow an untrusted currency string (webhook payload, request body, DB row)
 * to a `CurrencyCode`.
 *
 * @throws {InvalidCurrencyCodeError} when the code is outside the allow-list.
 */
export function assertSupportedCurrencyCode(value: string, context: string): CurrencyCode {
  if (!isSupportedCurrencyCode(value)) {
    throw new InvalidCurrencyCodeError(
      `${context}: unsupported currency code ${JSON.stringify(value)} (supported: ${SUPPORTED_CURRENCY_CODES.join(", ")})`,
    );
  }
  return value;
}
