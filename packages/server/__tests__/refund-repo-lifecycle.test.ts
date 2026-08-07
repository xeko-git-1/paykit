import * as refundRepo from "@vibecc/paykit-auth-core/db/repos/refund.repo.js";
/**
 * Refund lifecycle repo — the guards, and the arithmetic the guards protect.
 *
 * Two things here are load-bearing for money:
 *
 * 1. Every status transition is a CONDITIONAL update, guarded on the refund still
 *    being open. That guard is the exactly-once gate for a payout: a provider that
 *    redelivers its refund webhook, or a reconciler racing that webhook, must get
 *    "someone already resolved this" back rather than moving the money twice. A
 *    transition that forgot its guard would still pass a happy-path test, so the
 *    predicate is asserted directly.
 *
 * 2. The refundable remainder counts open refunds as well as succeeded ones. Only
 *    counting succeeded refunds lets two concurrent requests each be told there is
 *    room for the full balance, which over-refunds by design rather than by race.
 */
import { describe, expect, it, vi } from "vitest";

const REFUND_ID = "c0000000-0000-4000-8000-000000000001";
const TX_ID = "a0000000-0000-4000-8000-000000000001";
const ENTRY_ID = "d0000000-0000-4000-8000-000000000001";

/**
 * Records the `set` patch and the `where` predicate of an UPDATE so a test can
 * assert what was written and what it was conditional on. `rows` is what the
 * guarded update returns: one row when this caller won, none when it lost.
 */
function updateSpy(rows: unknown[]) {
  const seen: { patch?: Record<string, unknown>; where?: unknown } = {};
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        seen.patch = patch;
        return {
          where: (predicate: unknown) => {
            seen.where = predicate;
            return { returning: async () => rows };
          },
        };
      },
    }),
  } as never;
  return { db, seen };
}

/**
 * The values BOUND into a Drizzle predicate, so a guard like
 * `inArray(status, ["requested", "submitted"])` is greppable.
 *
 * Only bound parameters are collected, never column metadata. Walking the whole
 * object graph instead would pull in every column name on the table — including
 * `succeeded_at`, which reads as the status `succeeded` and would make an
 * assertion about which statuses a guard admits pass or fail for the wrong
 * reason. Columns are also cyclic (a column points back at its table), so the
 * narrower walk terminates without needing a visited set.
 */
function predicateValues(predicate: unknown): string {
  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    // A bound parameter: Drizzle pairs the value with the encoder that binds it.
    if ("value" in rec && "encoder" in rec) {
      values.push(String(rec.value));
      return;
    }
    // Nested SQL — recurse into its chunks only, skipping columns and tables.
    if (Array.isArray(rec.queryChunks)) {
      for (const chunk of rec.queryChunks) walk(chunk);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    }
  };
  walk(predicate);
  return values.join("|");
}

function selectSpy(totalMicros: string | undefined) {
  const seen: { where?: unknown } = {};
  const db = {
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => {
          seen.where = predicate;
          return totalMicros === undefined ? [] : [{ totalMicros }];
        },
      }),
    }),
  } as never;
  return { db, seen };
}

describe("refund transitions are guarded", () => {
  const openGuarded = [
    [
      "markSucceeded",
      () => refundRepo.markSucceeded,
      { refundId: REFUND_ID, ledgerEntryId: ENTRY_ID },
    ],
    [
      "markFailed",
      () => refundRepo.markFailed,
      { refundId: REFUND_ID, failureCode: "provider_rejected" },
    ],
    [
      "markRejected",
      () => refundRepo.markRejected,
      { refundId: REFUND_ID, failureCode: "exceeds_remaining" },
    ],
  ] as const;

  for (const [name, get, opts] of openGuarded) {
    it(`${name} only applies to a refund that has not resolved yet`, async () => {
      const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
      await get()(db, opts as never);
      const text = predicateValues(seen.where);
      // The three open statuses, and none of the resolved ones: a resolved refund
      // must not be re-resolved into a different outcome.
      expect(text).toContain("requested");
      expect(text).toContain("submitted");
      expect(text).toContain("pending_webhook");
      expect(text).not.toContain("succeeded");
    });

    it(`${name} reports nothing applied when the refund was already resolved`, async () => {
      const { db } = updateSpy([]);
      await expect(get()(db, opts as never)).resolves.toBeUndefined();
    });
  }

  it("markSubmitted only applies to a refund that has not been sent yet", async () => {
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markSubmitted(db, { refundId: REFUND_ID });
    const text = predicateValues(seen.where);
    expect(text).toContain("requested");
    // Re-submitting something already in flight would be a second provider call.
    expect(text).not.toContain("pending_webhook");
  });
});

describe("markSucceeded records where the money went", () => {
  it("sets the ledger entry together with the status, never one without the other", async () => {
    const now = new Date("2026-07-30T12:00:00Z");
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markSucceeded(db, {
      refundId: REFUND_ID,
      ledgerEntryId: ENTRY_ID,
      now,
    });
    // The table CHECK ties these together; writing the status without the entry id
    // would abort the transaction rather than corrupt the derived total, but the
    // repo is what has to get it right.
    expect(seen.patch).toMatchObject({
      status: "succeeded",
      ledgerEntryId: ENTRY_ID,
      succeededAt: now,
    });
  });

  it("carries the provider's refund id when the provider named it late", async () => {
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markSucceeded(db, {
      refundId: REFUND_ID,
      ledgerEntryId: ENTRY_ID,
      providerRefundId: "re_123",
    });
    expect(seen.patch).toMatchObject({ providerRefundId: "re_123" });
  });

  it("leaves the provider refund id untouched when this event did not carry one", async () => {
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markSucceeded(db, { refundId: REFUND_ID, ledgerEntryId: ENTRY_ID });
    // Absent, not null: overwriting a known id with null would orphan the row from
    // the provider's own record of the refund.
    expect(seen.patch).not.toHaveProperty("providerRefundId");
  });
});

describe("failure is distinguished from local refusal", () => {
  it("markFailed records a provider-side failure code", async () => {
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markFailed(db, {
      refundId: REFUND_ID,
      failureCode: "provider_rejected",
      failureMessage: "card no longer refundable",
    });
    expect(seen.patch).toMatchObject({
      status: "failed",
      failureCode: "provider_rejected",
      failureMessage: "card no longer refundable",
    });
  });

  it("markRejected is a separate status, because no provider call was made", async () => {
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markRejected(db, {
      refundId: REFUND_ID,
      failureCode: "exceeds_remaining",
    });
    // Someone diagnosing a missing refund needs to know whether the money was ever
    // asked for. Collapsing these two into one status loses that.
    expect(seen.patch).toMatchObject({ status: "rejected", failureCode: "exceeds_remaining" });
  });

  it("normalises an absent failure message to null rather than leaving it stale", async () => {
    const { db, seen } = updateSpy([{ refundId: REFUND_ID }]);
    await refundRepo.markFailed(db, { refundId: REFUND_ID, failureCode: "reconcile_timeout" });
    expect(seen.patch).toMatchObject({ failureMessage: null });
  });
});

describe("the refundable remainder", () => {
  it("sums only succeeded refunds for what has actually been returned", async () => {
    const { db, seen } = selectSpy("2500000");
    const total = await refundRepo.sumSucceededByTransaction(db, {
      transactionId: TX_ID,
      currencyCode: "USD",
    });
    expect(total).toBe("2500000");
    expect(predicateValues(seen.where)).toContain("succeeded");
  });

  it("sums open refunds too, so concurrent requests cannot both claim the balance", async () => {
    const { db, seen } = selectSpy("1000000");
    const total = await refundRepo.sumOpenByTransaction(db, {
      transactionId: TX_ID,
      currencyCode: "USD",
    });
    expect(total).toBe("1000000");
    const text = predicateValues(seen.where);
    expect(text).toContain("requested");
    expect(text).toContain("submitted");
    expect(text).toContain("pending_webhook");
  });

  it("is scoped by currency, since a wallet is keyed by it", async () => {
    const { db, seen } = selectSpy("0");
    await refundRepo.sumSucceededByTransaction(db, {
      transactionId: TX_ID,
      currencyCode: "VND",
    });
    // Summing across currencies would compare micros of different wallets and
    // report a remainder that belongs to neither.
    expect(predicateValues(seen.where)).toContain("VND");
  });

  it("reads no refunds as zero, not as undefined", async () => {
    const { db } = selectSpy(undefined);
    await expect(
      refundRepo.sumSucceededByTransaction(db, { transactionId: TX_ID, currencyCode: "USD" }),
    ).resolves.toBe("0");
  });
});

describe("createRefund is idempotent on the caller's key", () => {
  function insertSpy(insertedRows: unknown[], existingRows: unknown[]) {
    return {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => insertedRows }),
        }),
      }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => existingRows }) }),
      }),
    } as never;
  }

  const input = {
    transactionId: TX_ID,
    tenantId: "b0000000-0000-4000-8000-000000000001",
    ownerId: "b0000000-0000-4000-8000-000000000002",
    provider: "stripe",
    idempotencyKey: "key-1",
    amountMicros: "1000000",
    currencyCode: "USD",
  };

  it("reports created for a first request", async () => {
    const db = insertSpy([{ refundId: REFUND_ID, status: "requested" }], []);
    const { created } = await refundRepo.createRefund(db, input);
    expect(created).toBe(true);
  });

  it("returns the existing refund instead of a second one on a retry", async () => {
    const existing = { refundId: REFUND_ID, status: "succeeded" };
    const db = insertSpy([], [existing]);
    const result = await refundRepo.createRefund(db, input);
    // The caller needs `created: false` to know not to re-run the provider call —
    // that is what makes a retried HTTP request idempotent rather than a second
    // payout.
    expect(result).toEqual({ row: existing, created: false });
  });

  it("throws rather than inventing a row when the conflict was on some other constraint", async () => {
    const db = insertSpy([], []);
    await expect(refundRepo.createRefund(db, input)).rejects.toThrow(/could not be read back/);
  });
});
