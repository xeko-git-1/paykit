/**
 * Per-row reconciliation — rails that cannot list by window but can answer
 * about one reference at a time (VNPay querydr, Momo query, ZaloPay /v2/query).
 *
 * Before this branch existed those adapters returned `[]` from
 * `fetchTransactions`, and the differ read that emptiness as "the provider
 * settled nothing": every completed payment in the window became a fabricated
 * provider_missing discrepancy. Now the reconciler walks paykit's own rows and
 * asks the provider about each one.
 *
 * These tests use the REAL differ — the classification of settled / not_found
 * answers into matched / provider_missing is the behavior under test.
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

vi.mock("../src/reconcile/advisory-lock.js", () => ({
  tryAcquireReconcileLock: vi.fn(async () => true),
  releaseReconcileLock: vi.fn(async () => undefined),
}));

import { reconcileV15 } from "../src/reconcile/v15-orchestrator.js";

interface QueryAnswerByRef {
  [providerRef: string]:
    | { status: "settled"; amountMicros: string }
    | { status: "pending" }
    | { status: "not_found" }
    | { throw: string };
}

/** A per-row rail: no window listing, but answers one reference at a time. */
function perRowAdapter(id: string, answers: QueryAnswerByRef): PaymentProviderAdapter {
  return {
    id,
    canListTransactions: false,
    fetchTransactions: vi.fn().mockResolvedValue([]),
    queryTransaction: vi.fn(async (input: { providerRef: string }) => {
      const answer = answers[input.providerRef];
      if (answer === undefined) return { status: "not_found" };
      if ("throw" in answer) throw new Error(answer.throw);
      if (answer.status === "settled") {
        return {
          status: "settled",
          record: {
            providerRef: input.providerRef,
            amountMicros: answer.amountMicros,
            currencyCode: "VND",
          },
        };
      }
      return answer;
    }),
    refund: vi.fn(),
    verifyWebhookSignature: vi.fn(() => true),
    parseWebhookPayload: vi.fn(() => null),
  } as unknown as PaymentProviderAdapter;
}

function paymentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    transactionId: "txn-1",
    providerRef: "ref-1",
    amountMicros: "100000000000",
    currencyCode: "VND",
    status: "completed",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...overrides,
  };
}

function registryOf(...adapters: PaymentProviderAdapter[]): ProviderRegistry {
  return {
    get: (id: string) => adapters.find((a) => a.id === id),
    list: () => adapters,
  } as unknown as ProviderRegistry;
}

async function run(...adapters: PaymentProviderAdapter[]) {
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as never;
  return reconcileV15(
    { db, registry: registryOf(...adapters) },
    { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-01-02T00:00:00Z") },
  );
}

function storedSummary(): Record<string, unknown> {
  return mockCompleteRun.mock.calls.at(-1)?.[3] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartRun.mockResolvedValue({ runId: "run-1" });
  mockCompleteRun.mockResolvedValue(undefined);
  mockListPollable.mockResolvedValue([]);
  mockFindCursor.mockResolvedValue(undefined);
  mockPageOfPayments.mockResolvedValue([]);
  mockAdvanceCursor.mockResolvedValue(undefined);
  mockMarkWindowExhausted.mockResolvedValue(undefined);
});

describe("a rail with queryTransaction is reconciled per row, not skipped", () => {
  it("verifies each completed row against the provider and completes", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([
        paymentRow({ transactionId: "txn-1", providerRef: "ref-1" }),
        paymentRow({ transactionId: "txn-2", providerRef: "ref-2" }),
      ])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("vnpay", {
      "ref-1": { status: "settled", amountMicros: "100000000000" },
      "ref-2": { status: "settled", amountMicros: "100000000000" },
    });

    const result = await run(adapter);
    expect(result.status).toBe("completed");
    expect(adapter.queryTransaction).toHaveBeenCalledTimes(2);
    expect(adapter.fetchTransactions).not.toHaveBeenCalled();
    expect(result.summary?.perProvider.vnpay?.matched).toBe(2);
    expect(storedSummary().perRowProviders).toEqual(["vnpay"]);
    expect(storedSummary().notReconcilableProviders).toEqual([]);
  });

  it("passes the row's providerRef and createdAt so querydr can locate the transaction", async () => {
    const createdAt = new Date("2026-01-01T10:00:00Z");
    mockPageOfPayments
      .mockResolvedValueOnce([paymentRow({ providerRef: "ref-1", createdAt })])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("vnpay", {
      "ref-1": { status: "settled", amountMicros: "100000000000" },
    });

    await run(adapter);
    expect(adapter.queryTransaction).toHaveBeenCalledWith({ providerRef: "ref-1", createdAt });
  });

  it("flags provider_missing when the provider does not know the reference", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([
        paymentRow({ transactionId: "txn-1", providerRef: "ref-known" }),
        paymentRow({ transactionId: "txn-2", providerRef: "ref-ghost" }),
      ])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("momo", {
      "ref-known": { status: "settled", amountMicros: "100000000000" },
      "ref-ghost": { status: "not_found" },
    });

    const result = await run(adapter);
    expect(result.summary?.perProvider.momo?.matched).toBe(1);
    expect(result.summary?.perProvider.momo?.providerMissing).toBe(1);
    expect(result.summary?.discrepancies).toContainEqual(
      expect.objectContaining({ type: "provider_missing", transactionId: "txn-2" }),
    );
  });

  it("flags amount_mismatch when the provider settled a different amount", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([paymentRow({ providerRef: "ref-1", amountMicros: "100000000000" })])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("zalopay", {
      "ref-1": { status: "settled", amountMicros: "50000000000" },
    });

    const result = await run(adapter);
    expect(result.summary?.perProvider.zalopay?.amountMismatch).toBe(1);
  });

  it("treats a pending provider answer as unconfirmed money, not as settled", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([paymentRow({ providerRef: "ref-1" })])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("zalopay", { "ref-1": { status: "pending" } });

    const result = await run(adapter);
    expect(result.summary?.perProvider.zalopay?.providerMissing).toBe(1);
  });

  it("never queries rows that carry no settled money", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([
        paymentRow({ transactionId: "txn-1", status: "awaiting_payment", providerRef: "ref-1" }),
        paymentRow({ transactionId: "txn-2", status: "expired", providerRef: "ref-2" }),
        paymentRow({ transactionId: "txn-3", status: "completed", providerRef: null }),
      ])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("vnpay", {});

    const result = await run(adapter);
    expect(adapter.queryTransaction).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });
});

describe("a per-row query that throws", () => {
  it("marks the window incomplete and does not advance the cursor past the page", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([
        paymentRow({ transactionId: "txn-1", providerRef: "ref-ok" }),
        paymentRow({ transactionId: "txn-2", providerRef: "ref-boom" }),
      ])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("vnpay", {
      "ref-ok": { status: "settled", amountMicros: "100000000000" },
      "ref-boom": { throw: "provider timeout" },
    });

    const result = await run(adapter);
    // The window is not covered: partial, named as incomplete, and the cursor
    // stays put so the next run re-asks about the unanswered row.
    expect(result.status).toBe("partial");
    expect(storedSummary().incompleteProviders).toEqual(["vnpay"]);
    expect(mockAdvanceCursor).not.toHaveBeenCalled();
  });

  it("does not fabricate a provider_missing discrepancy for the unanswered row", async () => {
    mockPageOfPayments
      .mockResolvedValueOnce([paymentRow({ transactionId: "txn-2", providerRef: "ref-boom" })])
      .mockResolvedValue([]);
    const adapter = perRowAdapter("vnpay", { "ref-boom": { throw: "provider timeout" } });

    const result = await run(adapter);
    expect(result.summary?.perProvider.vnpay?.providerMissing).toBe(0);
    expect(result.summary?.discrepancies).toEqual([]);
  });
});

describe("a rail with neither listing nor per-reference lookup", () => {
  it("stays in the notReconcilable bucket (Binance Pay)", async () => {
    const binance = {
      id: "binance",
      canListTransactions: false,
      fetchTransactions: vi.fn().mockResolvedValue([]),
      refund: vi.fn(),
      verifyWebhookSignature: vi.fn(() => true),
      parseWebhookPayload: vi.fn(() => null),
    } as unknown as PaymentProviderAdapter;

    const result = await run(binance);
    expect(result.status).toBe("partial");
    expect(storedSummary().notReconcilableProviders).toEqual(["binance"]);
    expect(storedSummary().perRowProviders).toEqual([]);
  });
});

describe("run status arithmetic counts per-row rails as attemptable", () => {
  it("reports failed when the only adapter is per-row and its verification failed outright", async () => {
    mockFindCursor.mockImplementation(async () => {
      throw new Error("cursor table unreachable");
    });
    // findCursor throwing inside the per-row branch is caught per adapter and
    // recorded as an adapter error — with one adapter registered, that is
    // every adapter, so the run failed.
    const adapter = perRowAdapter("vnpay", {});
    const result = await run(adapter);
    expect(result.status).toBe("failed");
    expect(storedSummary().adapterErrors).toMatchObject({
      vnpay: "cursor table unreachable",
    });
  });

  it("an empty window on a per-row rail completes and is marked exhausted", async () => {
    mockPageOfPayments.mockResolvedValue([]);
    const adapter = perRowAdapter("momo", {});
    const result = await run(adapter);
    expect(result.status).toBe("completed");
    expect(mockMarkWindowExhausted).toHaveBeenCalledWith(expect.anything(), {
      provider: "momo",
      window: expect.anything(),
    });
  });
});
