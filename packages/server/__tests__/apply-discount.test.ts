import type { AppliedDiscount } from "@vibecc/paykit";
import { describe, expect, it, vi } from "vitest";
import { applyDiscountInTx, resolveDiscount } from "../src/routes/checkout/apply-discount.js";

const FAKE_TX = {} as unknown;

describe("resolveDiscount (lookup phase, before transaction)", () => {
  it("returns null with reason 'no-resolver' when resolver is undefined", async () => {
    const result = await resolveDiscount({
      req: {},
      amountMicros: 1_000_000n,
      currencyCode: "USD",
    });
    expect(result.discount).toBeNull();
    expect(result.reason).toBe("no-resolver");
  });

  it("returns null with reason 'resolver-null' when resolver returns null", async () => {
    const result = await resolveDiscount({
      resolver: async () => null,
      req: {},
      amountMicros: 1_000_000n,
      currencyCode: "USD",
    });
    expect(result.discount).toBeNull();
    expect(result.reason).toBe("resolver-null");
  });

  it("returns the AppliedDiscount when resolver returns one", async () => {
    const discount: AppliedDiscount = {
      percent: 10,
      code: "WELCOME",
      sourceId: "uuid-1",
      consume: async () => true,
    };
    const result = await resolveDiscount({
      resolver: async () => discount,
      req: {},
      amountMicros: 1_000_000n,
      currencyCode: "USD",
    });
    expect(result.discount).toBe(discount);
    expect(result.reason).toBeUndefined();
  });

  it("returns null with reason 'resolver-threw' + warns logger when resolver throws", async () => {
    const warn = vi.fn();
    const result = await resolveDiscount({
      resolver: async () => {
        throw new Error("DB down");
      },
      req: {},
      amountMicros: 1_000_000n,
      currencyCode: "USD",
      logger: { warn },
    });
    expect(result.discount).toBeNull();
    expect(result.reason).toBe("resolver-threw");
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("applyDiscountInTx (consume phase, inside transaction)", () => {
  it("returns full price when discount is null", async () => {
    const r = await applyDiscountInTx({
      discount: null,
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(false);
    expect(r.effectiveMicros).toBe(1_000_000n);
    expect(r.discount).toBeNull();
  });

  it("applies 10% discount on success: 1_000_000 → 900_000 micros", async () => {
    const consume = vi.fn(async () => true);
    const discount: AppliedDiscount = {
      percent: 10,
      code: "TEN",
      sourceId: "u1",
      consume,
    };
    const r = await applyDiscountInTx({
      discount,
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(true);
    expect(r.effectiveMicros).toBe(900_000n);
    expect(r.originalMicros).toBe(1_000_000n);
    expect(consume).toHaveBeenCalledWith(FAKE_TX);
  });

  it("applies 50% discount: halves amount", async () => {
    const r = await applyDiscountInTx({
      discount: {
        percent: 50,
        code: "HALF",
        sourceId: "u",
        consume: async () => true,
      },
      tx: FAKE_TX,
      amountMicros: 2_000_000n,
    });
    expect(r.applied).toBe(true);
    expect(r.effectiveMicros).toBe(1_000_000n);
  });

  it("falls back to full price + warn log when consume() returns false (race lost)", async () => {
    const warn = vi.fn();
    const r = await applyDiscountInTx({
      discount: {
        percent: 20,
        code: "RACE",
        sourceId: "u",
        consume: async () => false,
      },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
      logger: { warn },
    });
    expect(r.applied).toBe(false);
    expect(r.effectiveMicros).toBe(1_000_000n);
    expect(r.reason).toBe("consume-lost");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("falls back to full price + warn log when consume() throws", async () => {
    const warn = vi.fn();
    const r = await applyDiscountInTx({
      discount: {
        percent: 30,
        code: "ERR",
        sourceId: "u",
        consume: async () => {
          throw new Error("fk violation");
        },
      },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
      logger: { warn },
    });
    expect(r.applied).toBe(false);
    expect(r.effectiveMicros).toBe(1_000_000n);
    expect(r.reason).toBe("resolver-threw");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("applies fractional 12.5% exactly (bps, not rounded to 13%): 1_000_000 → 875_000", async () => {
    const r = await applyDiscountInTx({
      discount: { percent: 12.5, code: "FRAC", sourceId: "u", consume: async () => true },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(true);
    // Rounding the percent (old behaviour) would give 13% → 870_000. bps math keeps it exact.
    expect(r.effectiveMicros).toBe(875_000n);
  });

  it("applies sub-1% discount 0.4% instead of silently dropping it to 0%", async () => {
    const r = await applyDiscountInTx({
      discount: { percent: 0.4, code: "TINY", sourceId: "u", consume: async () => true },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(true);
    // Old Math.round(0.4) = 0 would charge full price; bps=40 deducts 4_000 micros.
    expect(r.effectiveMicros).toBe(996_000n);
  });

  it("applies 100% discount: effective amount is zero", async () => {
    const r = await applyDiscountInTx({
      discount: { percent: 100, code: "FREE", sourceId: "u", consume: async () => true },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(true);
    expect(r.effectiveMicros).toBe(0n);
  });

  it("applies 0% discount: full price, still marked applied", async () => {
    const r = await applyDiscountInTx({
      discount: { percent: 0, code: "ZERO", sourceId: "u", consume: async () => true },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(true);
    expect(r.effectiveMicros).toBe(1_000_000n);
  });

  it("rejects out-of-range percent (>100): falls back to full price", async () => {
    const r = await applyDiscountInTx({
      discount: {
        percent: 150,
        code: "BAD",
        sourceId: "u",
        consume: async () => true,
      },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(false);
    expect(r.effectiveMicros).toBe(1_000_000n);
  });

  it("rejects NaN percent without throwing: falls back to full price", async () => {
    const r = await applyDiscountInTx({
      discount: {
        percent: Number.NaN,
        code: "BAD",
        sourceId: "u",
        consume: async () => true,
      },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(false);
    expect(r.effectiveMicros).toBe(1_000_000n);
  });

  it("rejects negative percent: falls back to full price", async () => {
    const r = await applyDiscountInTx({
      discount: {
        percent: -10,
        code: "BAD",
        sourceId: "u",
        consume: async () => true,
      },
      tx: FAKE_TX,
      amountMicros: 1_000_000n,
    });
    expect(r.applied).toBe(false);
    expect(r.effectiveMicros).toBe(1_000_000n);
  });
});
