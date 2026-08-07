/**
 * usdToMicros — the dollars→micros conversion the checkout routes share.
 *
 * The behaviour that matters is the refusal. Three routers each carried their own
 * `BigInt(Math.round(amountUsd * 100)) * 10_000n`, which silently rounds: a caller
 * naming `1.005` is charged either 100 or 101 cents depending on how the float
 * landed, and nothing in the response says the amount changed. So the tests below
 * pin two things together — ordinary prices must survive float representation, and
 * an amount that genuinely names a fraction of a cent must throw rather than be
 * rounded into one.
 */
import { describe, expect, it } from "vitest";
import { usdToMicros } from "../src/money/usd-native.js";

describe("usdToMicros — exact conversions", () => {
  const cases: ReadonlyArray<readonly [number, bigint]> = [
    [0, 0n],
    [1, 1_000_000n],
    [0.01, 10_000n],
    [0.1, 100_000n],
    [19.99, 19_990_000n],
    [500, 500_000_000n],
    [123.45, 123_450_000n],
  ];

  for (const [dollars, micros] of cases) {
    it(`${dollars} USD → ${micros} micros`, () => {
      expect(usdToMicros(dollars)).toBe(micros);
    });
  }

  it("survives amounts whose float representation is not exact", () => {
    // 19.99 * 100 is 1998.9999999999998 in binary floating point, so a strict
    // integer test would reject ordinary prices. These are the amounts that break
    // a naive `Number.isInteger(amountUsd * 100)` check.
    for (const dollars of [1.1, 2.03, 4.07, 8.29, 19.99, 29.97, 70.07, 100.01]) {
      expect(() => usdToMicros(dollars)).not.toThrow();
    }
  });

  it("agrees with the hand-rolled conversion it replaces, for whole-cent input", () => {
    // The three routers used this expression. For input that names a whole number
    // of cents the results must be identical, or replacing them changes prices.
    for (const dollars of [1, 1.5, 19.99, 250, 499.99]) {
      const handRolled = BigInt(Math.round(dollars * 100)) * 10_000n;
      expect(usdToMicros(dollars)).toBe(handRolled);
    }
  });
});

describe("usdToMicros — amounts it must refuse", () => {
  it("rejects a fraction of a cent rather than rounding it", () => {
    // The defect in one sentence: this used to become either 100 or 101 cents.
    expect(() => usdToMicros(1.005)).toThrow(/whole number of cents/);
  });

  it("rejects other sub-cent amounts", () => {
    for (const dollars of [0.001, 0.005, 2.0001, 10.999]) {
      expect(() => usdToMicros(dollars)).toThrow(/whole number of cents/);
    }
  });

  it("rejects a negative amount", () => {
    expect(() => usdToMicros(-1)).toThrow(/non-negative/);
  });

  it("rejects NaN and infinities", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => usdToMicros(bad)).toThrow(/finite/);
    }
  });
});

describe("usdToMicros — mirrors vndToMicros", () => {
  it("refuses sub-unit precision the way the VND helper refuses fractional dong", () => {
    // Both helpers exist so a caller's stated amount is either representable or
    // refused. Neither may quietly adjust it.
    expect(() => usdToMicros(1.005)).toThrow();
  });
});
