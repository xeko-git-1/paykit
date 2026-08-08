/**
 * How a reconciliation window is walked, and what happens when it does not fit.
 *
 * The run used to select every payment in its window in one statement, with no
 * limit, and hold the result in memory. Two consequences, both worst exactly when
 * reconciliation matters: a large window could exhaust the process, and a run that
 * died partway had no memory of how far it got — so the next invocation restarted
 * the same window and died in the same place. A window too big to finish in one
 * attempt could never be finished at all.
 *
 * The subtle part is not the paging, it is the differ. It compares both directions
 * and flags a provider record with no paykit row as `paykit_missing`. Diffing one
 * page of paykit rows against the FULL provider list would therefore report every
 * record outside that page as missing — thousands of fabricated discrepancies per
 * batch, which is worse than not reconciling, because it buries the real ones.
 */
import type { PaymentProviderAdapter, ProviderRegistry } from "@vibecc/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStartRun = vi.fn();
const mockCompleteRun = vi.fn();
const mockListPollable = vi.fn();
const mockFindCursor = vi.fn();
const mockPageOfPayments = vi.fn();
const mockAdvanceCursor = vi.fn();
const mockMarkWindowExhausted = vi.fn();

vi.mock("@vibecc/paykit-server", () => ({
  paymentTransactions: {
    transactionId: "transaction_id",
    createdAt: "created_at",
    provider: "provider",
    providerRef: "provider_ref",
  },
  pendingRefundRepo: {
    listPollable: (...args: unknown[]) => mockListPollable(...args),
    recordPollAttempt: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    markTimedOut: vi.fn(),
  },
  ledgerRepo: {
    appendLedgerEntryIdempotent: vi.fn(),
    sumRefundsByOriginalTransaction: vi.fn(),
  },
  balanceRepo: { applyDelta: vi.fn() },
  reconciliationRepo: {
    startRun: (...args: unknown[]) => mockStartRun(...args),
    completeRun: (...args: unknown[]) => mockCompleteRun(...args),
  },
  reconciliationCursorRepo: {
    findCursor: (...args: unknown[]) => mockFindCursor(...args),
    // Mirrors the real function's contract, including the two cases that return
    // "start from the beginning": a finished window, and a position belonging to a
    // different window. A stub that ignored `exhausted` would let this file pass
    // while the orchestrator re-walked completed windows in production.
    resumePosition: (
      cursor:
        | {
            lastCreatedAt?: Date;
            lastTransactionId?: string;
            windowSince?: Date;
            windowUntil?: Date;
            exhausted?: boolean;
          }
        | undefined,
      window: { since: Date; until: Date },
    ) => {
      if (cursor === undefined || cursor.exhausted === true) return undefined;
      if (cursor.lastCreatedAt === undefined || cursor.lastTransactionId === undefined) {
        return undefined;
      }
      if (
        cursor.windowSince?.getTime() !== window.since.getTime() ||
        cursor.windowUntil?.getTime() !== window.until.getTime()
      ) {
        return undefined;
      }
      return { createdAt: cursor.lastCreatedAt, transactionId: cursor.lastTransactionId };
    },
    pageOfPayments: (...args: unknown[]) => mockPageOfPayments(...args),
    advanceCursor: (...args: unknown[]) => mockAdvanceCursor(...args),
    markWindowExhausted: (...args: unknown[]) => mockMarkWindowExhausted(...args),
    resetCursor: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gte: (a: unknown, b: unknown) => ({ gte: [a, b] }),
  lt: (a: unknown, b: unknown) => ({ lt: [a, b] }),
}));

vi.mock("../src/reconcile/advisory-lock.js", () => ({
  tryAcquireReconcileLock: vi.fn().mockResolvedValue(true),
  releaseReconcileLock: vi.fn().mockResolvedValue(undefined),
}));

import { reconcileV15 } from "../src/reconcile/v15-orchestrator.js";

const SINCE = new Date("2026-01-01T00:00:00Z");
const UNTIL = new Date("2026-01-02T00:00:00Z");

/** A paykit row as the cursor repo returns it. */
function row(n: number) {
  return {
    transactionId: `tx-${n}`,
    providerRef: `ref-${n}`,
    amountMicros: "1000000",
    currencyCode: "USD",
    status: "completed",
    createdAt: new Date(SINCE.getTime() + n * 1000),
  };
}

/** A provider record that matches `row(n)`. */
function record(n: number) {
  return { providerRef: `ref-${n}`, amountMicros: "1000000", currencyCode: "USD" };
}

function adapterWith(records: readonly unknown[]): PaymentProviderAdapter {
  return {
    id: "stripe",
    displayName: "Stripe",
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",
    createCheckout: async () => {
      throw new Error("unused");
    },
    verifyWebhookSignature: () => true,
    parseWebhookPayload: () => null,
    refund: async () => ({ state: "unsupported" as const }),
    fetchTransactions: async () => records,
  } as unknown as PaymentProviderAdapter;
}

function registryOf(adapter: PaymentProviderAdapter): ProviderRegistry {
  return {
    get: (id: string) => (id === adapter.id ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
}

const db = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
} as never;

function run(adapter: PaymentProviderAdapter, opts: Record<string, unknown> = {}) {
  return reconcileV15(
    { db, registry: registryOf(adapter), logger: { warn: vi.fn() } },
    { since: SINCE, until: UNTIL, ...opts },
  );
}

/** Pages returned in sequence, so one call per batch. */
function pages(...batches: unknown[][]) {
  let i = 0;
  mockPageOfPayments.mockImplementation(async () => batches[i++] ?? []);
}

function summaryWritten(): Record<string, unknown> {
  const call = mockCompleteRun.mock.calls.at(-1);
  return (call?.[3] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartRun.mockResolvedValue({ runId: "run-1" });
  mockCompleteRun.mockResolvedValue(undefined);
  mockListPollable.mockResolvedValue([]);
  mockFindCursor.mockResolvedValue(undefined);
  mockAdvanceCursor.mockResolvedValue(undefined);
  mockMarkWindowExhausted.mockResolvedValue(undefined);
  mockPageOfPayments.mockResolvedValue([]);
});

describe("walking a window in batches", () => {
  it("does not invent discrepancies for records a later page will match", async () => {
    // The defect this whole design turns on. Two batches, and every provider record
    // has a paykit row — so a correct run finds nothing missing.
    pages([row(1), row(2)], [row(3), row(4)], []);
    const result = await run(adapterWith([record(1), record(2), record(3), record(4)]), {
      batchSize: 2,
    });

    const stats = result.summary?.perProvider.stripe;
    expect(stats?.matched).toBe(4);
    expect(stats?.paykitMissing).toBe(0);
    expect(result.summary?.discrepancies).toHaveLength(0);
  });

  it("reports a genuinely absent record once the window is fully walked", async () => {
    // record(9) has no paykit row in any page. That IS a real discrepancy — money at
    // the provider this database has no record of — and it must survive paging.
    pages([row(1)], []);
    const result = await run(adapterWith([record(1), record(9)]), { batchSize: 1 });

    const stats = result.summary?.perProvider.stripe;
    expect(stats?.matched).toBe(1);
    expect(stats?.paykitMissing).toBe(1);
    expect(result.summary?.discrepancies.map((d) => d.providerRef)).toEqual(["ref-9"]);
  });

  it("accumulates counts across batches rather than reporting only the last", async () => {
    pages([row(1)], [row(2)], [row(3)], []);
    const result = await run(adapterWith([record(1), record(2), record(3)]), { batchSize: 1 });

    expect(result.summary?.perProvider.stripe?.matched).toBe(3);
  });

  it("stops paging when a short page says the window is done", async () => {
    // A page smaller than the batch size is the end; asking again would be a wasted
    // round trip on every run.
    pages([row(1), row(2)], [row(3)]);
    await run(adapterWith([record(1), record(2), record(3)]), { batchSize: 2 });

    expect(mockPageOfPayments).toHaveBeenCalledTimes(2);
  });

  it("advances the cursor only after a batch has been diffed", async () => {
    pages([row(1), row(2)], []);
    await run(adapterWith([record(1), record(2)]), { batchSize: 2 });

    // A cursor moved ahead of the work would mark payments reconciled that nobody
    // compared, and the next run would skip straight past them.
    const [, opts] = mockAdvanceCursor.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.position).toEqual({ createdAt: row(2).createdAt, transactionId: "tx-2" });
    expect(opts.window).toEqual({ since: SINCE, until: UNTIL });
  });

  it("records an empty window as finished so it is not re-walked forever", async () => {
    pages([]);
    const result = await run(adapterWith([]));

    expect(mockMarkWindowExhausted).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
  });
});

describe("resuming", () => {
  it("starts from the stored position instead of the top of the window", async () => {
    mockFindCursor.mockResolvedValue({
      provider: "stripe",
      lastCreatedAt: row(5).createdAt,
      lastTransactionId: "tx-5",
      windowSince: SINCE,
      windowUntil: UNTIL,
      exhausted: false,
    });
    pages([row(6)], []);

    await run(adapterWith([record(6)]), { batchSize: 1 });

    const [, opts] = mockPageOfPayments.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.after).toEqual({ createdAt: row(5).createdAt, transactionId: "tx-5" });
  });

  it("skips a provider whose window was already finished", async () => {
    mockFindCursor.mockResolvedValue({
      provider: "stripe",
      lastCreatedAt: row(5).createdAt,
      lastTransactionId: "tx-5",
      windowSince: SINCE,
      windowUntil: UNTIL,
      exhausted: true,
    });

    const result = await run(adapterWith([record(1)]));

    // Re-walking a completed window from its final position reconciles nothing,
    // forever.
    expect(mockPageOfPayments).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });
});

describe("hitting the batch ceiling", () => {
  it("reports partial, not completed, when rows are left in the window", async () => {
    // Nothing failed, but part of the window has not been looked at. Calling that
    // `completed` tells an operator the window is reconciled when it is not.
    mockPageOfPayments.mockResolvedValue([row(1)]);
    const result = await run(adapterWith([record(1)]), { batchSize: 1, maxBatchesPerProvider: 2 });

    expect(result.status).toBe("partial");
    expect(summaryWritten().incompleteProviders).toEqual(["stripe"]);
  });

  it("honours the ceiling rather than draining the backlog in one run", async () => {
    // The bound is what keeps one invocation from holding the reconcile lock and a
    // pooled connection for an unbounded time.
    mockPageOfPayments.mockResolvedValue([row(1)]);
    await run(adapterWith([record(1)]), { batchSize: 1, maxBatchesPerProvider: 3 });

    expect(mockPageOfPayments).toHaveBeenCalledTimes(3);
  });

  it("does not call unmatched records missing while the window is unfinished", async () => {
    // A later page may still match them. Reporting them now would invent a
    // discrepancy for every payment this run has not reached.
    mockPageOfPayments.mockResolvedValue([row(1)]);
    const result = await run(adapterWith([record(1), record(9)]), {
      batchSize: 1,
      maxBatchesPerProvider: 1,
    });

    expect(result.summary?.perProvider.stripe?.paykitMissing).toBe(0);
  });
});

describe("an adapter that fails", () => {
  it("does not stop the other providers or lose the run", async () => {
    const failing = {
      ...adapterWith([]),
      id: "stripe",
      fetchTransactions: async () => {
        throw new Error("provider 503");
      },
    } as unknown as PaymentProviderAdapter;

    const result = await run(failing);

    expect(result.status).toBe("failed");
    expect(mockCompleteRun).toHaveBeenCalled();
  });
});
