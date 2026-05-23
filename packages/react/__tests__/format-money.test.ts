import { describe, expect, it } from "vitest";
import { formatMicros } from "../src/lib/format-money.js";

describe("formatMicros", () => {
  it("formats USD: 1_000_000 micros → $1.00", () => {
    expect(formatMicros("1000000", "USD", "en-US")).toBe("$1.00");
  });

  it("formats USD: 100_000_000 micros → $100.00 ($10 top-up)", () => {
    expect(formatMicros("100000000", "USD", "en-US")).toBe("$100.00");
  });

  it("formats USD with thousand separators", () => {
    expect(formatMicros("100000000000", "USD", "en-US")).toBe("$100,000.00");
  });

  it("strips Postgres numeric(20,6) decimal trail before formatting", () => {
    expect(formatMicros("1000000.000000", "USD", "en-US")).toBe("$1.00");
  });

  it("formats VND: 1_000_000_000 micros → ₫1,000 VND", () => {
    // 1 VND = 1_000_000 micros, so 1_000 VND = 1_000_000_000 micros
    const out = formatMicros("1000000000", "VND");
    expect(out).toContain("1.000"); // vi-VN locale
    expect(out).toContain("₫");
  });

  it("formats large VND amounts: 250M VND = 250 × 10^6 × 10^6 micros", () => {
    const out = formatMicros("250000000000000", "VND");
    expect(out).toContain("250.000.000");
    expect(out).toContain("₫");
  });

  it("zero amount: USD → $0.00", () => {
    expect(formatMicros("0", "USD", "en-US")).toBe("$0.00");
  });
});
