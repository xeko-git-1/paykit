/**
 * Currency registry + generic amount conversion + the checkout decision table.
 *
 * The behaviours that matter:
 *
 *   - The registry and the CurrencyCode union cannot drift: every union member
 *     has an entry and every entry names a union member (SUPPORTED_CURRENCY_CODES
 *     is the same set — the runtime guard).
 *   - `amountToMicros` refuses what a currency cannot express instead of
 *     rounding it: half a yen does not exist, a third of a cent does not exist.
 *   - `resolveCheckoutAmount` keeps the legacy amountUsd/amountVnd behaviour
 *     byte-for-byte (messages included) while adding the generic pair, and
 *     rejects a body that names both styles rather than ranking them.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENCY_REGISTRY,
  SUPPORTED_CURRENCY_CODES,
  amountToMicros,
  currencyExponent,
  minorUnitsToMicros,
  resolveCheckoutAmount,
} from "../src/money/index.js";

describe("CURRENCY_REGISTRY", () => {
  it("covers exactly the supported currency codes", () => {
    expect(Object.keys(CURRENCY_REGISTRY).sort()).toEqual([...SUPPORTED_CURRENCY_CODES].sort());
  });

  it("names the settled exponents: cents for USD/EUR, none for VND/JPY/KRW", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("VND")).toBe(0);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
  });

  it("every entry's code names its own key", () => {
    for (const [key, info] of Object.entries(CURRENCY_REGISTRY)) {
      expect(info.code).toBe(key);
    }
  });
});

describe("amountToMicros — 2-decimal currencies", () => {
  it("converts whole-cent amounts exactly (float representation included)", () => {
    expect(amountToMicros("USD", 19.99)).toBe(19_990_000n);
    expect(amountToMicros("EUR", 0.01)).toBe(10_000n);
    expect(amountToMicros("EUR", 123.45)).toBe(123_450_000n);
  });

  it("refuses a fraction of a cent instead of rounding it", () => {
    expect(() => amountToMicros("USD", 1.005)).toThrow(/whole number of cents/);
    expect(() => amountToMicros("EUR", 0.001)).toThrow(/whole number of cents/);
  });
});

describe("amountToMicros — zero-decimal currencies", () => {
  it("converts integer amounts at 1 unit = 1_000_000 micros", () => {
    expect(amountToMicros("JPY", 1000)).toBe(1_000_000_000n);
    expect(amountToMicros("KRW", 50_000)).toBe(50_000_000_000n);
    expect(amountToMicros("VND", 250_000)).toBe(250_000_000_000n);
  });

  it("refuses fractional amounts — half a yen does not exist", () => {
    expect(() => amountToMicros("JPY", 100.5)).toThrow(/integer/);
    expect(() => amountToMicros("KRW", 0.5)).toThrow(/integer/);
  });
});

describe("amountToMicros — shared refusals", () => {
  it("refuses negative and non-finite amounts", () => {
    expect(() => amountToMicros("USD", -1)).toThrow(/non-negative/);
    expect(() => amountToMicros("JPY", Number.NaN)).toThrow(/finite/);
    expect(() => amountToMicros("EUR", Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("minorUnitsToMicros", () => {
  it("treats minor units per the exponent: cents for USD, whole yen for JPY", () => {
    expect(minorUnitsToMicros("USD", 1999)).toBe(19_990_000n); // 1999 cents
    expect(minorUnitsToMicros("JPY", 1000)).toBe(1_000_000_000n); // 1000 yen
  });

  it("refuses fractional and negative inputs — the wire said integer", () => {
    expect(() => minorUnitsToMicros("USD", 10.5)).toThrow(/integer/);
    expect(() => minorUnitsToMicros("JPY", -1)).toThrow(/non-negative/);
  });
});

describe("resolveCheckoutAmount — legacy style preserved", () => {
  it("USD provider still requires amountUsd, same message", () => {
    const out = resolveCheckoutAmount({ input: {}, adapterCurrencies: ["USD"] });
    expect(out).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "amountUsd required for USD provider",
    });
  });

  it("VND provider still requires amountVnd, same message", () => {
    const out = resolveCheckoutAmount({ input: {}, adapterCurrencies: ["VND"] });
    expect(out).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "amountVnd required for VND provider",
    });
  });

  it("legacy amounts convert exactly as before", () => {
    expect(resolveCheckoutAmount({ input: { amountUsd: 25 }, adapterCurrencies: ["USD"] })).toEqual(
      { ok: true, currency: "USD", amountMicros: 25_000_000n },
    );
    expect(
      resolveCheckoutAmount({ input: { amountVnd: 250_000 }, adapterCurrencies: ["VND"] }),
    ).toEqual({ ok: true, currency: "VND", amountMicros: 250_000_000_000n });
  });

  it("a provider with no legacy field points the caller at the generic style", () => {
    const out = resolveCheckoutAmount({ input: {}, adapterCurrencies: ["JPY"] });
    expect(out).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "amount and currency required for JPY provider",
    });
  });
});

describe("resolveCheckoutAmount — generic style", () => {
  it("explicit currency wins and converts through the registry", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 1000, currency: "JPY" },
      adapterCurrencies: ["JPY", "USD"],
    });
    expect(out).toEqual({ ok: true, currency: "JPY", amountMicros: 1_000_000_000n });
  });

  it("falls back to the tenant preference when currency is omitted", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 50 },
      adapterCurrencies: ["USD", "EUR"],
      preferredCurrency: "EUR",
    });
    expect(out).toEqual({ ok: true, currency: "EUR", amountMicros: 50_000_000n });
  });

  it("falls back to the adapter's first currency when no preference exists", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 50 },
      adapterCurrencies: ["USD"],
    });
    expect(out).toEqual({ ok: true, currency: "USD", amountMicros: 50_000_000n });
  });

  it("rejects a currency the adapter does not support — even a preferred one", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 50 },
      adapterCurrencies: ["USD"],
      preferredCurrency: "EUR",
    });
    expect(out).toEqual({
      ok: false,
      code: "UNSUPPORTED_CURRENCY",
      message: "provider supports: USD",
    });
  });

  it("rejects a currency outside the registry", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 50, currency: "GBP" },
      adapterCurrencies: ["USD"],
    });
    expect(out).toEqual({
      ok: false,
      code: "UNSUPPORTED_CURRENCY",
      message: "unsupported currency: GBP",
    });
  });

  it("an inexpressible amount is a validation error, not a 500", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 100.5, currency: "JPY" },
      adapterCurrencies: ["JPY"],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("VALIDATION_ERROR");
      expect(out.message).toMatch(/integer/);
    }
  });
});

describe("resolveCheckoutAmount — ambiguity refused", () => {
  it("rejects a body naming both the generic and a legacy amount", () => {
    const out = resolveCheckoutAmount({
      input: { amount: 50, amountUsd: 25 },
      adapterCurrencies: ["USD"],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/not both/);
  });

  it("rejects currency without an amount", () => {
    const out = resolveCheckoutAmount({
      input: { currency: "USD" },
      adapterCurrencies: ["USD"],
    });
    expect(out).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "amount is required when currency is set",
    });
  });
});
