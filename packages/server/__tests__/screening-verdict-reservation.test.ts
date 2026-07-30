/**
 * Verdict transactions — the exactly-once gate, the money move, and the discount
 * reservation the webhook deliberately left held.
 *
 * The webhook parks a payment without resolving its promo reservation, because at
 * park time the outcome is unknown. That makes these two functions the only place
 * the slot is resolved: committed when the payment is credited, released when it
 * is quarantined. A bug here strands promo capacity permanently, so the ownership
 * is asserted rather than assumed.
 *
 * The fence under test is the conditional status transition. Both functions must
 * treat "the payment was no longer screening_pending" as a no-op, never as a
 * reason to move money a second time.
 */
import { describe, expect, it, vi } from "vitest";
import {
  creditScreenedPayment,
  quarantineScreenedPayment,
} from "../src/services/screening-verdict-tx.js";

const TX_ID = "a0000000-0000-4000-8000-000000000001";

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "b0000000-0000-4000-8000-000000000009",
    transactionId: TX_ID,
    tenantId: "tenant-1",
    ownerId: "owner-1",
    provider: "sepay",
    sourceId: "prov-ref-1",
    creditMicros: "750000000",
    currencyCode: "VND",
    eventJson: {},
    state: "in_progress",
    attempts: 1,
    ...overrides,
  } as never;
}

/**
 * `transitionRows` is what the guarded UPDATE returns: one row when this caller
 * won the transition, none when someone already moved the payment on.
 */
function makeDb(transitionRows: unknown[]) {
  const captured: { where: unknown[] } = { where: [] };
  const tx = {
    update: () => ({
      set: () => ({
        where: (predicate: unknown) => {
          captured.where.push(predicate);
          return { returning: async () => transitionRows };
        },
      }),
    }),
  };
  return {
    db: { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as never,
    captured,
  };
}

function creditDeps(overrides: Record<string, unknown> = {}) {
  return {
    appendLedgerEntryIdempotent: vi.fn().mockResolvedValue({ row: {}, inserted: true }),
    applyDelta: vi.fn().mockResolvedValue(undefined),
    markScreeningDecided: vi.fn().mockResolvedValue({}),
    commitReservation: vi.fn().mockResolvedValue(true),
    releaseReservation: vi.fn().mockResolvedValue(true),
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...overrides,
  } as never;
}

function quarantineDeps(overrides: Record<string, unknown> = {}) {
  return {
    state: "rejected",
    reason: "sanctioned counterparty",
    markScreeningDecided: vi.fn().mockResolvedValue({}),
    commitReservation: vi.fn().mockResolvedValue(true),
    releaseReservation: vi.fn().mockResolvedValue(true),
    now: new Date("2026-07-28T00:00:00.000Z"),
    ...overrides,
  } as never;
}

describe("creditScreenedPayment", () => {
  it("credits the frozen amount and commits the reservation when it wins the transition", async () => {
    const { db } = makeDb([{ metadataJson: { discountId: "disc-1" } }]);
    const deps = creditDeps();
    const out = await creditScreenedPayment(db, job(), deps);

    expect(out.applied).toBe(true);
    expect(deps.appendLedgerEntryIdempotent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entryType: "credit",
        amountMicros: "750000000",
        currencyCode: "VND",
        sourceId: "prov-ref-1",
        ownerId: "owner-1",
      }),
    );
    expect(deps.applyDelta).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "VND",
      750_000_000n,
    );
    expect(deps.commitReservation).toHaveBeenCalledWith(expect.anything(), "disc-1");
    expect(deps.releaseReservation).not.toHaveBeenCalled();
    expect(deps.markScreeningDecided).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "cleared" }),
    );
  });

  it("moves no money when the payment already left screening_pending", async () => {
    const { db } = makeDb([]);
    const deps = creditDeps();
    const out = await creditScreenedPayment(db, job(), deps);

    expect(out.applied).toBe(false);
    expect(deps.appendLedgerEntryIdempotent).not.toHaveBeenCalled();
    expect(deps.applyDelta).not.toHaveBeenCalled();
    expect(deps.commitReservation).not.toHaveBeenCalled();
    expect(deps.markScreeningDecided).not.toHaveBeenCalled();
  });

  it("leaves the projection alone when the ledger row already existed", async () => {
    const { db } = makeDb([{ metadataJson: {} }]);
    const deps = creditDeps({
      appendLedgerEntryIdempotent: vi.fn().mockResolvedValue({ row: {}, inserted: false }),
    });
    const out = await creditScreenedPayment(db, job(), deps);

    // The ledger is the source of truth: a resend collapses onto the existing row,
    // and applying the delta again would double the balance.
    expect(out.applied).toBe(true);
    expect(deps.applyDelta).not.toHaveBeenCalled();
  });

  it("touches no reservation when the checkout never reserved one", async () => {
    const { db } = makeDb([{ metadataJson: {} }]);
    const deps = creditDeps();
    await creditScreenedPayment(db, job(), deps);

    expect(deps.commitReservation).not.toHaveBeenCalled();
    expect(deps.releaseReservation).not.toHaveBeenCalled();
  });
});

describe("quarantineScreenedPayment", () => {
  it("releases the reservation and writes no ledger entry", async () => {
    const { db } = makeDb([{ metadataJson: { discountId: "disc-1" } }]);
    const deps = quarantineDeps();
    const out = await quarantineScreenedPayment(db, job(), deps);

    expect(out.applied).toBe(true);
    // Quarantine is terminal, so the promo slot goes back to the pool.
    expect(deps.releaseReservation).toHaveBeenCalledWith(expect.anything(), "disc-1");
    expect(deps.commitReservation).not.toHaveBeenCalled();
    expect(deps.markScreeningDecided).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "rejected", reason: "sanctioned counterparty" }),
    );
  });

  it("records manual_review distinctly so a human queue can be built on it", async () => {
    const { db } = makeDb([{ metadataJson: {} }]);
    const deps = quarantineDeps({ state: "manual_review", reason: "inconclusive" });
    await quarantineScreenedPayment(db, job(), deps);

    expect(deps.markScreeningDecided).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "manual_review" }),
    );
  });

  it("is a no-op when the payment already left screening_pending", async () => {
    const { db } = makeDb([]);
    const deps = quarantineDeps();
    const out = await quarantineScreenedPayment(db, job(), deps);

    expect(out.applied).toBe(false);
    expect(deps.releaseReservation).not.toHaveBeenCalled();
    expect(deps.markScreeningDecided).not.toHaveBeenCalled();
  });
});
