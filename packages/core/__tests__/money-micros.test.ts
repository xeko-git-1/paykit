import { describe, expect, it } from "vitest";
import { microsStringToBigInt, microsStringToNumber } from "../src/money/micros.js";

describe("microsStringToBigInt", () => {
  it("parses integer micros string", () => {
    expect(microsStringToBigInt("1000000")).toBe(1_000_000n);
  });

  it("strips Postgres decimal trailing (numeric(20,6) round-trip)", () => {
    expect(microsStringToBigInt("1000000.000000")).toBe(1_000_000n);
  });

  it("handles zero", () => {
    expect(microsStringToBigInt("0")).toBe(0n);
    expect(microsStringToBigInt("0.000000")).toBe(0n);
  });

  it("handles large values beyond JS safe integer", () => {
    const huge = "999999999999999999";
    expect(microsStringToBigInt(huge)).toBe(999_999_999_999_999_999n);
  });

  it("handles empty fractional part safely", () => {
    expect(microsStringToBigInt("42.")).toBe(42n);
  });

  it("round-trip fuzz 1000 times", () => {
    for (let i = 0; i < 1000; i++) {
      const n = BigInt(Math.floor(Math.random() * 1_000_000_000));
      const str = `${n}.000000`;
      expect(microsStringToBigInt(str)).toBe(n);
    }
  });
});

describe("microsStringToNumber", () => {
  it("parses integer micros within safe range", () => {
    expect(microsStringToNumber("1000000")).toBe(1_000_000);
  });

  it("throws on non-finite", () => {
    expect(() => microsStringToNumber("not-a-number")).toThrow(/Invalid micros/);
  });

  it("throws when exceeding MAX_SAFE_INTEGER", () => {
    expect(() => microsStringToNumber("9007199254740993")).toThrow(/exceeds JS safe int/);
  });
});
