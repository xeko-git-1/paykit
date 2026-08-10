/**
 * Discount consume ordering + failure containment.
 *
 * Two properties that the earlier implementation got wrong:
 *   1. An unusable percent must not spend a redemption — validation runs first,
 *      so `consume` is never called.
 *   2. A `consume` that fails must leave no partial side effect and must leave
 *      the surrounding transaction usable, so the full-price fallback can run.
 *
 * The savepoint semantics themselves are exercised against real Postgres in
 * `discount-consume-savepoint-pg.test.ts`; this file pins the call contract.
 */
import type { AppliedDiscount, DbTransaction } from "@xeko-git-1/paykit";
import { describe, expect, it, vi } from "vitest";
import { applyDiscountInTx } from "../src/routes/checkout/apply-discount.js";

/**
 * Stand-in for a Drizzle transaction handle: `transaction()` runs the callback
 * and, on throw, reports that it rolled back rather than propagating a
 * poisoned-transaction state. Mirrors the observable contract verified against
 * Postgres, without pretending to implement SAVEPOINT.
 */
function txWithSavepoint(): { tx: DbTransaction; rollbacks: number; commits: number } {
  const state = { rollbacks: 0, commits: 0 };
  const tx = {
    transaction: async (fn: (nested: unknown) => Promise<void>) => {
      try {
        await fn(tx);
        state.commits += 1;
      } catch (err) {
        state.rollbacks += 1;
        throw err;
      }
    },
  };
  return {
    tx: tx as DbTransaction,
    get rollbacks() {
      return state.rollbacks;
    },
    get commits() {
      return state.commits;
    },
  };
}

function discountWith(percent: number, consume: AppliedDiscount["consume"]): AppliedDiscount {
  return { percent, code: "CODE", sourceId: "src-1", consume };
}

describe("percent is validated before consume", () => {
  for (const percent of [150, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`does not call consume() for an out-of-range percent (${percent})`, async () => {
      const consume = vi.fn(async () => true);
      const harness = txWithSavepoint();
      const r = await applyDiscountInTx({
        discount: discountWith(percent, consume),
        tx: harness.tx,
        amountMicros: 1_000_000n,
      });
      expect(consume).not.toHaveBeenCalled();
      expect(r.applied).toBe(false);
      expect(r.effectiveMicros).toBe(1_000_000n);
      expect(r.reason).toBe("percent-out-of-range");
    });
  }

  it("calls consume() exactly once for an in-range percent", async () => {
    const consume = vi.fn(async () => true);
    const harness = txWithSavepoint();
    const r = await applyDiscountInTx({
      discount: discountWith(25, consume),
      tx: harness.tx,
      amountMicros: 1_000_000n,
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(r.applied).toBe(true);
    expect(r.effectiveMicros).toBe(750_000n);
  });
});

describe("consume failure is contained in a savepoint", () => {
  it("rolls back the nested transaction when consume throws", async () => {
    const harness = txWithSavepoint();
    const r = await applyDiscountInTx({
      discount: discountWith(10, async () => {
        throw new Error("unique violation");
      }),
      tx: harness.tx,
      amountMicros: 1_000_000n,
    });
    expect(harness.rollbacks).toBe(1);
    expect(harness.commits).toBe(0);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("resolver-threw");
    expect(r.effectiveMicros).toBe(1_000_000n);
  });

  it("rolls back when consume returns false, so a write-then-lose leaves nothing", async () => {
    const harness = txWithSavepoint();
    const r = await applyDiscountInTx({
      discount: discountWith(10, async () => false),
      tx: harness.tx,
      amountMicros: 1_000_000n,
    });
    expect(harness.rollbacks).toBe(1);
    expect(harness.commits).toBe(0);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("consume-lost");
  });

  it("releases the savepoint when consume succeeds", async () => {
    const harness = txWithSavepoint();
    await applyDiscountInTx({
      discount: discountWith(10, async () => true),
      tx: harness.tx,
      amountMicros: 1_000_000n,
    });
    expect(harness.commits).toBe(1);
    expect(harness.rollbacks).toBe(0);
  });

  it("does not leak the internal race signal to the caller", async () => {
    const harness = txWithSavepoint();
    await expect(
      applyDiscountInTx({
        discount: discountWith(10, async () => false),
        tx: harness.tx,
        amountMicros: 1_000_000n,
      }),
    ).resolves.toMatchObject({ applied: false });
  });

  it("still works when the handle has no savepoint support", async () => {
    const consume = vi.fn(async () => true);
    const r = await applyDiscountInTx({
      discount: discountWith(10, consume),
      tx: {} as DbTransaction,
      amountMicros: 1_000_000n,
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(r.applied).toBe(true);
    expect(r.effectiveMicros).toBe(900_000n);
  });
});
