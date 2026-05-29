/**
 * NowPayments canonical-JSON tests (Phase 03 tests #7-8).
 *
 * Phase 01 verified scheme: HMAC-SHA512 over JSON.stringify(sortedByKeys(body)).
 * These tests prove the canonical form is stable under key reordering.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, sortKeysDeep } from "../src/canonical-json.js";

describe("canonical-json key-sort", () => {
  it("produces identical bytes for objects differing only in key order", () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("recurses into nested objects", () => {
    const a = { z: { b: 1, a: 2 }, x: 3 };
    const b = { x: 3, z: { a: 2, b: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array order (arrays are semantic, not keyed)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize({ k: [3, 1, 2] })).toBe('{"k":[3,1,2]}');
  });

  it("handles primitives, null, and empty objects", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
    expect(canonicalize({})).toBe("{}");
  });

  it("sortKeysDeep is idempotent", () => {
    const obj = { c: { z: 1, a: 2 }, b: [3, 1, 2], a: 4 };
    const once = sortKeysDeep(obj);
    const twice = sortKeysDeep(once);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("canonical-json fuzz (1000 permutations)", () => {
  it("1000 random key permutations of the same NP IPN payload all hash to the same canonical string", () => {
    const referenceKeys = [
      "payment_id",
      "invoice_id",
      "payment_status",
      "pay_address",
      "price_amount",
      "price_currency",
      "pay_amount",
      "actually_paid",
      "pay_currency",
      "order_id",
      "order_description",
      "outcome_amount",
      "outcome_currency",
    ] as const;
    const referenceValues: Record<string, string | number> = {
      payment_id: 5524759814,
      invoice_id: 4944017921,
      payment_status: "finished",
      pay_address: "0xa1b2c3",
      price_amount: 50,
      price_currency: "usd",
      pay_amount: 50,
      actually_paid: 50,
      pay_currency: "usdcmatic",
      order_id: "tx-uuid-aaaa-bbbb",
      order_description: "Top up",
      outcome_amount: 49.5,
      outcome_currency: "usd",
    };

    const expected = canonicalize(referenceValues);
    for (let i = 0; i < 1000; i++) {
      const shuffled = [...referenceKeys].sort(() => Math.random() - 0.5);
      const obj: Record<string, string | number> = {};
      for (const key of shuffled) obj[key] = referenceValues[key]!;
      expect(canonicalize(obj)).toBe(expected);
    }
  });
});
