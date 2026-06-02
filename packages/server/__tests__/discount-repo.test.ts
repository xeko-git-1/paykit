/**
 * discount.repo unit tests.
 *
 * findActiveByCode's active/expiry filtering is tested directly. The
 * reserve/commit/release race-safety lives in each guarded UPDATE's WHERE
 * clause (a DB-level guarantee not reproducible without real Postgres), so here
 * we assert each maps "rows returned" → true and "no rows" → false; the
 * concurrency guarantee itself is covered by the migration CHECK + guarded
 * UPDATE shape.
 */
import { describe, expect, it } from "vitest";
import {
  commitReservation,
  findActiveByCode,
  releaseReservation,
  reserve,
} from "../src/db/repos/discount.repo.js";
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

describe("reserve / commitReservation / releaseReservation", () => {
  it("reserve returns true when the guarded UPDATE matched a row", async () => {
    expect(await reserve(updateDb([{ discountId: "d-1" }]), "d-1")).toBe(true);
  });

  it("reserve returns false when the cap is reached (UPDATE matched nothing)", async () => {
    expect(await reserve(updateDb([]), "d-1")).toBe(false);
  });

  it("commitReservation returns true when a reservation was committed", async () => {
    expect(await commitReservation(updateDb([{ discountId: "d-1" }]), "d-1")).toBe(true);
  });

  it("commitReservation returns false on a resent webhook (reserved already 0)", async () => {
    expect(await commitReservation(updateDb([]), "d-1")).toBe(false);
  });

  it("releaseReservation returns true when a reservation was freed", async () => {
    expect(await releaseReservation(updateDb([{ discountId: "d-1" }]), "d-1")).toBe(true);
  });

  it("releaseReservation returns false when there was nothing to release", async () => {
    expect(await releaseReservation(updateDb([]), "d-1")).toBe(false);
  });
});
