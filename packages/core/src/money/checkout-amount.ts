/**
 * Checkout amount resolution — the one decision table both checkout routers
 * (embedded server and /v1 service) share, so "which currency is this payment
 * in and how many micros is it" cannot drift between them.
 *
 * Two request styles coexist:
 *
 *   - Legacy: `amountUsd` / `amountVnd` — kept verbatim because existing
 *     integrations send them, and each field names its own currency.
 *   - Generic: `amount` + optional `currency` — the multi-currency path. When
 *     `currency` is omitted it falls back to the tenant's stored preference,
 *     then to the adapter's first supported currency.
 *
 * Mixing the styles in one request is rejected rather than ranked: a body
 * naming both `amount` and `amountUsd` has two candidate charges, and picking
 * one silently is how a customer is charged an amount they never confirmed.
 *
 * This is a pure function — the tenant-preference lookup is async and stays in
 * the routers, which pass the result in as `preferredCurrency`.
 */

import type { CurrencyCode } from "../types/money.js";
import { isSupportedCurrencyCode } from "./currency-codes.js";
import { amountToMicros } from "./currency-registry.js";

export interface CheckoutAmountInput {
  readonly amount?: number | undefined;
  readonly currency?: string | undefined;
  readonly amountUsd?: number | undefined;
  readonly amountVnd?: number | undefined;
}

export type CheckoutAmountResolution =
  | { readonly ok: true; readonly currency: CurrencyCode; readonly amountMicros: bigint }
  | {
      readonly ok: false;
      readonly code: "VALIDATION_ERROR" | "UNSUPPORTED_CURRENCY";
      readonly message: string;
    };

export function resolveCheckoutAmount(opts: {
  readonly input: CheckoutAmountInput;
  readonly adapterCurrencies: readonly CurrencyCode[];
  readonly preferredCurrency?: CurrencyCode | undefined;
}): CheckoutAmountResolution {
  const { input, adapterCurrencies, preferredCurrency } = opts;

  if (input.amount !== undefined) {
    if (input.amountUsd !== undefined || input.amountVnd !== undefined) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "provide either amount (+ currency) or amountUsd/amountVnd, not both",
      };
    }
    const currency = input.currency ?? preferredCurrency ?? adapterCurrencies[0] ?? "USD";
    if (!isSupportedCurrencyCode(currency)) {
      return {
        ok: false,
        code: "UNSUPPORTED_CURRENCY",
        message: `unsupported currency: ${currency}`,
      };
    }
    if (!adapterCurrencies.includes(currency)) {
      return {
        ok: false,
        code: "UNSUPPORTED_CURRENCY",
        message: `provider supports: ${adapterCurrencies.join(", ")}`,
      };
    }
    try {
      return { ok: true, currency, amountMicros: amountToMicros(currency, input.amount) };
    } catch (err) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: err instanceof Error ? err.message : "invalid amount",
      };
    }
  }

  if (input.currency !== undefined) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: "amount is required when currency is set",
    };
  }

  // Legacy dispatch — behaviour preserved exactly, error messages included.
  const currency: CurrencyCode = adapterCurrencies[0] ?? "USD";
  if (currency === "USD") {
    if (input.amountUsd === undefined) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "amountUsd required for USD provider",
      };
    }
    return { ok: true, currency, amountMicros: amountToMicros("USD", input.amountUsd) };
  }
  if (currency === "VND") {
    if (input.amountVnd === undefined) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "amountVnd required for VND provider",
      };
    }
    return { ok: true, currency, amountMicros: amountToMicros("VND", input.amountVnd) };
  }
  // The adapter's native currency has no legacy field — the generic style is
  // the only way to name an amount in it.
  return {
    ok: false,
    code: "VALIDATION_ERROR",
    message: `amount and currency required for ${currency} provider`,
  };
}
