/**
 * discount.repo unit tests.
 *
 * findActiveByCode's active/expiry filtering is tested directly. The redeem()
 * race-safety lives in the guarded UPDATE's WHERE clause (a DB-level guarantee
 * not reproducible without real Postgres), so here we assert redeem correctly
 * maps "rows returned" → true and "no rows" → false; the concurrency guarantee
 * itself is covered by the migration's CHECK + the guarded UPDATE shape.
 */
import { describe, expect, it, vi } from "vitest";
import { findActiveByCode, redeem } from "../src/db/repos/discount.repo.js";
import type { DbOrTx } from "../src/db/client.js";

function selectDb(row: unknown): DbOrTx {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as unknown as DbOrTx;
}

function updateDb(returnedRows: unknown[]): DbOrTx {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => returnedRows,
        }),
      }),
    }),
  } as unknown as DbOrTx;
}

const baseRow = {
  discountId: "d-1",
  tenantId: "t-1",
  code: "SAVE10",
  percent: "10.00",
  maxRedemptions: 100,
  timesRedeemed: 3,
  active: true,
  expiresAt: null as Date | null,
};

describe("findActiveByCode", () => {
  it("returns the row when active and unexpired", async () => {
    const row = await findActiveByCode(selectDb(baseRow), "t-1", "SAVE10");
    expect(row?.code).toBe("SAVE10");
  });

  it("returns undefined when the code does not exist", async () => {
    const row = await findActiveByCode(selectDb(null), "t-1", "NOPE");
    expect(row).toBeUndefined();
  });

  it("returns undefined when the code is deactivated", async () => {
    const row = await findActiveByCode(selectDb({ ...baseRow, active: false }), "t-1", "SAVE10");
    expect(row).toBeUndefined();
  });

  it("returns undefined when the code has expired", async () => {
    const expired = { ...baseRow, expiresAt: new Date("2020-01-01T00:00:00Z") };
    const row = await findActiveByCode(selectDb(expired), "t-1", "SAVE10", new Date());
    expect(row).toBeUndefined();
  });

  it("returns the row when expiry is in the future", async () => {
    const future = { ...baseRow, expiresAt: new Date(Date.now() + 86_400_000) };
    const row = await findActiveByCode(selectDb(future), "t-1", "SAVE10");
    expect(row?.code).toBe("SAVE10");
  });
});

describe("redeem", () => {
  it("returns true when the guarded UPDATE matched a row", async () => {
    expect(await redeem(updateDb([{ discountId: "d-1" }]), "d-1")).toBe(true);
  });

  it("returns false when the UPDATE matched nothing (cap reached / expired / inactive)", async () => {
    expect(await redeem(updateDb([]), "d-1")).toBe(false);
  });
});
