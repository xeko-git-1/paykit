import { describe, expect, it } from "vitest";
import { UnsupportedCurrencyError } from "../src/errors/index.js";
import { stripeUsdAmountToMicros, vndToMicros } from "../src/money/index.js";

describe("stripeUsdAmountToMicros", () => {
  it("converts cents to micros (cents × 10_000)", () => {
    expect(stripeUsdAmountToMicros(100, "usd")).toBe(1_000_000n); // $1.00 = 1M micros
    expect(stripeUsdAmountToMicros(1000, "usd")).toBe(10_000_000n); // $10
    expect(stripeUsdAmountToMicros(1, "usd")).toBe(10_000n); // $0.01
  });

  it("accepts uppercase currency", () => {
    expect(stripeUsdAmountToMicros(100, "USD")).toBe(1_000_000n);
  });

  it("rejects non-USD currency", () => {
    expect(() => stripeUsdAmountToMicros(100, "eur")).toThrow(UnsupportedCurrencyError);
    expect(() => stripeUsdAmountToMicros(100, "vnd")).toThrow(UnsupportedCurrencyError);
  });

  it("handles zero", () => {
    expect(stripeUsdAmountToMicros(0, "usd")).toBe(0n);
  });

  it("rounds non-integer cents (Stripe always sends integers but defensive)", () => {
    expect(stripeUsdAmountToMicros(100.4, "usd")).toBe(1_000_000n);
    expect(stripeUsdAmountToMicros(100.6, "usd")).toBe(1_010_000n);
  });
});

describe("vndToMicros (VND-native, no synthetic FX)", () => {
  it("multiplies VND × 1_000_000 to get micros", () => {
    expect(vndToMicros(1000)).toBe(1_000_000_000n);
    expect(vndToMicros(250_000)).toBe(250_000_000_000n);
  });

  it("handles zero", () => {
    expect(vndToMicros(0)).toBe(0n);
  });

  it("rejects non-integer VND (no fractional dong exist)", () => {
    expect(() => vndToMicros(1000.5)).toThrow(/integer/);
  });

  it("rejects negative", () => {
    expect(() => vndToMicros(-100)).toThrow(/non-negative/);
  });
});
