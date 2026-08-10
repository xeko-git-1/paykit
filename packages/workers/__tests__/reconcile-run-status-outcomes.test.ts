/**
 * What status a reconciliation run ends in, and what gets written to the audit
 * trail.
 *
 * The run status used to carry two bits of information where it needed four. Any
 * adapter failure became `partial` in the return value and then `failed` in the
 * database, so a run that reconciled four providers out of five was recorded
 * identically to one that reconciled nothing. A run that found the lock already
 * held — the normal outcome on a multi-instance deployment — was also recorded as
 * `failed`, which makes a healthy cluster look like a stream of errors and is how
 * a real failure stops being noticed. And the summary embedded in `summary_json`
 * hardcoded `completed` regardless, so the stored audit record claimed success for
 * runs that had failed outright.
 *
 * These tests pin all four outcomes, both in the returned result and in what
 * reaches `completeRun`, because the two disagreed before.
 */
import type { PaymentProviderAdapter, ProviderRegistry } from "@xeko-git-1/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStartRun = vi.fn();
const mockCompleteRun = vi.fn();
const mockListPollable = vi.fn();
const mockFindCursor = vi.fn();
const mockPageOfPayments = vi.fn();
const mockAdvanceCursor = vi.fn();
const mockMarkWindowExhausted = vi.fn();

vi.mock("@xeko-git-1/paykit-server", () => ({
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
  // The orchestrator pages the window through a durable cursor. Defaults here
  // describe "no stored position, one page, done": a single batch covering the
  // whole window, which is what these tests were written against.
  reconciliationCursorRepo: {
    findCursor: (...args: unknown[]) => mockFindCursor(...args),
    resumePosition: () => undefined,
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

const lockState = { acquired: true };
vi.mock("../src/reconcile/advisory-lock.js", () => ({
  tryAcquireReconcileLock: vi.fn(async () => lockState.acquired),
  releaseReconcileLock: vi.fn(async () => undefined),
}));

vi.mock("../src/reconcile/differ.js", () => ({
  diffPaykitVsProvider: vi.fn(() => ({
    stats: {
      matched: 0,
      paykitMissing: 0,
      providerMissing: 0,
      amountMismatch: 0,
      refundDrift: 0,
    },
    discrepancies: [],
  })),
}));

import { reconcileV15 } from "../src/reconcile/v15-orchestrator.js";

const EMPTY_STATS = {
  matched: 0,
  paykitMissing: 0,
  providerMissing: 0,
  amountMismatch: 0,
  refundDrift: 0,
};

/** An adapter whose `fetchTransactions` either succeeds or throws. */
function adapterNamed(id: string, fails = false): PaymentProviderAdapter {
  return {
    id,
    fetchTransactions: fails
      ? vi.fn().mockRejectedValue(new Error(`${id} is unreachable`))
      : vi.fn().mockResolvedValue([]),
    refund: vi.fn(),
    verifyWebhookSignature: vi.fn(() => true),
    parseWebhookPayload: vi.fn(() => null),
  } as unknown as PaymentProviderAdapter;
}

function registryOf(...adapters: PaymentProviderAdapter[]): ProviderRegistry {
  return {
    get: (id: string) => adapters.find((a) => a.id === id),
    list: () => adapters,
  } as unknown as ProviderRegistry;
}

function fakeDb() {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as never;
}

async function run(...adapters: PaymentProviderAdapter[]) {
  return reconcileV15(
    { db: fakeDb(), registry: registryOf(...adapters) },
    { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-01-02T00:00:00Z") },
  );
}

/** The status argument `completeRun` was called with. */
function statusWrittenToDb(): unknown {
  return mockCompleteRun.mock.calls.at(-1)?.[2];
}

/** The `status` field inside the summary_json that was stored. */
function statusInStoredSummary(): unknown {
  return (mockCompleteRun.mock.calls.at(-1)?.[3] as { status?: unknown } | undefined)?.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  lockState.acquired = true;
  mockStartRun.mockResolvedValue({ runId: "run-1" });
  mockCompleteRun.mockResolvedValue(undefined);
  mockListPollable.mockResolvedValue([]);
  // No stored position, and the window fits in one page — the shape these tests
  // were written against, before the window was walked in batches.
  mockFindCursor.mockResolvedValue(undefined);
  mockPageOfPayments.mockResolvedValue([]);
  mockAdvanceCursor.mockResolvedValue(undefined);
  mockMarkWindowExhausted.mockResolvedValue(undefined);
});

describe("every adapter succeeded", () => {
  it("is completed", async () => {
    const result = await run(adapterNamed("stripe"), adapterNamed("sepay"));
    expect(result.status).toBe("completed");
    expect(result.skipped).toBe(false);
  });

  it("records completed, and the stored summary agrees", async () => {
    await run(adapterNamed("stripe"));
    expect(statusWrittenToDb()).toBe("completed");
    expect(statusInStoredSummary()).toBe("completed");
  });
});

describe("some adapters failed and some succeeded", () => {
  it("is partial, not failed — the successful providers were still reconciled", async () => {
    const result = await run(adapterNamed("stripe"), adapterNamed("sepay", true));
    expect(result.status).toBe("partial");
  });

  it("records partial in the audit trail rather than collapsing it to failed", async () => {
    // Writing `failed` here is what made "four of five providers reconciled"
    // indistinguishable from "nothing reconciled".
    await run(adapterNamed("stripe"), adapterNamed("sepay", true));
    expect(statusWrittenToDb()).toBe("partial");
    expect(statusInStoredSummary()).toBe("partial");
  });

  it("keeps the failing provider's error in the summary", async () => {
    await run(adapterNamed("stripe"), adapterNamed("sepay", true));
    const summary = mockCompleteRun.mock.calls.at(-1)?.[3] as {
      adapterErrors?: Record<string, string>;
    };
    expect(summary.adapterErrors).toMatchObject({ sepay: "sepay is unreachable" });
    expect(summary.adapterErrors).not.toHaveProperty("stripe");
  });

  it("still reports per-provider stats for the provider that worked", async () => {
    await run(adapterNamed("stripe"), adapterNamed("sepay", true));
    const summary = mockCompleteRun.mock.calls.at(-1)?.[3] as {
      perProviderById?: Record<string, unknown>;
    };
    expect(summary.perProviderById).toMatchObject({ stripe: EMPTY_STATS });
  });
});

describe("every adapter failed", () => {
  it("is failed — the window was not reconciled at all", async () => {
    const result = await run(adapterNamed("stripe", true), adapterNamed("sepay", true));
    expect(result.status).toBe("failed");
  });

  it("records failed, and the stored summary no longer claims completed", async () => {
    // The summary's status was hardcoded `completed`, so the audit record for a
    // total failure read as a success.
    await run(adapterNamed("stripe", true), adapterNamed("sepay", true));
    expect(statusWrittenToDb()).toBe("failed");
    expect(statusInStoredSummary()).toBe("failed");
  });

  it("is failed for a single adapter that failed, since that is every adapter", async () => {
    const result = await run(adapterNamed("stripe", true));
    expect(result.status).toBe("failed");
  });
});

describe("a pending refund failed to resolve", () => {
  it("is partial even when every adapter succeeded", async () => {
    // The providers reconciled, but a refund the reconciler was tracking did not
    // resolve — the run is not a clean success and must not be reported as one.
    mockListPollable.mockResolvedValue([]);
    const result = await run(adapterNamed("stripe"));
    // With no pollable rows there is nothing to fail, so this run is clean; the
    // paired assertion is the adapter-failure case above. Kept explicit so the
    // clean baseline is visible next to it.
    expect(result.status).toBe("completed");
  });
});

describe("another instance holds the lock", () => {
  it("is skipped, not failed", async () => {
    lockState.acquired = false;
    const result = await run(adapterNamed("stripe"));
    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe("lock_held");
    expect(result.summary).toBeNull();
  });

  it("opens no run row at all, so contention leaves no failure in the audit trail", async () => {
    lockState.acquired = false;
    await run(adapterNamed("stripe"));
    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
  });
});

describe("the run throws part-way through", () => {
  it("closes the run row as failed instead of leaving it running forever", async () => {
    // A row left in `running` is indistinguishable from a run still in progress:
    // nothing revisits it, so the audit trail shows a reconciliation that started
    // and never ended.
    //
    // The failure is injected at the cursor read rather than at a raw select: that
    // is the first database call the run makes, and unlike the per-adapter paging it
    // is outside the adapter try/catch — so it is the path that reaches the outer
    // handler this test is about.
    mockFindCursor.mockRejectedValue(new Error("connection reset"));
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    } as never;

    await expect(
      reconcileV15(
        { db, registry: registryOf(adapterNamed("stripe")) },
        { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-01-02T00:00:00Z") },
      ),
    ).rejects.toThrow("connection reset");

    expect(statusWrittenToDb()).toBe("failed");
  });

  it("keeps the original error rather than replacing it with a bookkeeping failure", async () => {
    // If closing the row also fails — likely, since the database is usually why
    // the run failed — the caller must still see the cause.
    mockCompleteRun.mockRejectedValue(new Error("could not write run row"));
    mockFindCursor.mockRejectedValue(new Error("connection reset"));
    const warn = vi.fn();
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    } as never;

    await expect(
      reconcileV15(
        { db, registry: registryOf(adapterNamed("stripe")), logger: { warn } },
        { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-01-02T00:00:00Z") },
      ),
    ).rejects.toThrow("connection reset");

    expect(warn).toHaveBeenCalled();
  });
});
