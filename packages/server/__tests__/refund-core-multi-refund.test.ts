/**
 * Tests for reserve-then-reconcile refund correctness.
 * Validates:
 *   - Dedup-before-gate: retry of a full refund returns existing result (not 400)
 *   - Reservation counts toward remaining: concurrent over-refund rejected before PSP
 *   - PSP failure releases reservation headroom
 *   - Distinct refunds (different Idempotency-Key) persist independently
 *   - Full refund marks tx status='refunded'
 *   - Mutation-resistant: reverting reserve-before-PSP ordering fails tests
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProviderRegistry, RefundResult } from "@xeko-git-1/paykit";
import type { PaymentTransaction } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";
import type { LedgerEntry } from "@xeko-git-1/paykit-auth-core/db/schema/ledger-entries.js";
import type { PendingRefund } from "@xeko-git-1/paykit-auth-core/db/schema/pending-refunds.js";

// ---------------------------------------------------------------------------
// Mock repo modules
// ---------------------------------------------------------------------------

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
  findLedgerEntryBySourceId: vi.fn(),
  sumRefundsByOriginalTransaction: vi.fn(),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js", () => ({
  applyDelta: vi.fn().mockResolvedValue({ tenantId: "t", currencyCode: "USD", currentBalanceMicros: "0" }),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  createPendingRefund: vi.fn(),
  findByProviderAndKey: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  sumActiveReservationsByTransaction: vi.fn(),
}));

// Import AFTER mocks
import { executeRefund, type RefundCoreDeps, type RefundActor } from "../src/services/refund-core.js";
import { appendLedgerEntryIdempotent, findLedgerEntryBySourceId, sumRefundsByOriginalTransaction } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { applyDelta } from "@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js";
import { createPendingRefund, findByProviderAndKey, markCompleted, markFailed, sumActiveReservationsByTransaction } from "@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js";

const mockAppendIdempotent = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mockFindLedgerBySourceId = findLedgerEntryBySourceId as ReturnType<typeof vi.fn>;
const mockSumRefunds = sumRefundsByOriginalTransaction as ReturnType<typeof vi.fn>;
const mockApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mockCreatePendingRefund = createPendingRefund as ReturnType<typeof vi.fn>;
const mockFindByProviderAndKey = findByProviderAndKey as ReturnType<typeof vi.fn>;
const mockMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mockMarkFailed = markFailed as ReturnType<typeof vi.fn>;
const mockSumActiveReservations = sumActiveReservationsByTransaction as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_ID = "00000000-0000-0000-0000-000000000002";
const TX_ID = "00000000-0000-0000-0000-000000000099";

function makeTxRow(overrides?: Partial<PaymentTransaction>): PaymentTransaction {
  return {
    transactionId: TX_ID,
    tenantId: TENANT_ID,
    ownerId: OWNER_ID,
    provider: "stripe",
    amountMicros: "10000000", // 10.00 in micros
    currencyCode: "USD",
    status: "completed",
    providerRef: "pi_abc123",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PaymentTransaction;
}

const ADMIN_ACTOR: RefundActor = { kind: "admin", adminUserId: "admin-1", role: "super_admin" };

function createFakeAdapter(result: RefundResult = { state: "completed", providerRefundId: "prov-ref-1" }) {
  return { refund: vi.fn().mockResolvedValue(result) };
}

function createFakeRegistry(adapter: { refund: ReturnType<typeof vi.fn> }): ProviderRegistry {
  return { get: () => adapter } as unknown as ProviderRegistry;
}

/** Fake DB with transaction support — tx proxy passes through to mocked repo functions */
function createFakeDb() {
  const txStatusUpdates: Array<{ transactionId: string; status: string }> = [];

  const txProxy = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve([{ id: TX_ID }]),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (data: { status?: string }) => ({
        where: () => {
          if (data.status) txStatusUpdates.push({ transactionId: TX_ID, status: data.status });
          return Promise.resolve();
        },
      }),
    }),
  };

  const db = {
    transaction: async <T>(fn: (tx: typeof txProxy) => Promise<T>): Promise<T> => fn(txProxy),
  };

  return { db: db as unknown as RefundCoreDeps["db"], txProxy, txStatusUpdates };
}

/**
 * In-memory model of pending_refunds + ledger for multi-call scenarios.
 * Tracks reservations and ledger entries to provide realistic mock behavior.
 */
function createRefundStore() {
  const reservations: Array<{
    pendingId: string;
    provider: string;
    idempotencyKey: string;
    transactionId: string;
    amountMicros: string;
    currencyCode: string;
    state: string;
  }> = [];
  const ledgerEntries: Array<{
    entryId: string;
    provider: string;
    sourceId: string;
    entryType: string;
    amountMicros: string;
  }> = [];
  let reservationCounter = 0;
  let ledgerCounter = 0;

  return {
    reservations,
    ledgerEntries,

    /** Mock for findByProviderAndKey */
    findReservation(_tx: unknown, opts: { provider: string; idempotencyKey: string }) {
      return reservations.find(
        (r) => r.provider === opts.provider && r.idempotencyKey === opts.idempotencyKey,
      ) as PendingRefund | undefined;
    },

    /** Mock for findLedgerEntryBySourceId */
    findLedger(_tx: unknown, opts: { provider: string; sourceId: string; entryType: string }) {
      return ledgerEntries.find(
        (e) => e.provider === opts.provider && e.sourceId === opts.sourceId && e.entryType === opts.entryType,
      ) as unknown as LedgerEntry | undefined;
    },

    /** Mock for sumActiveReservationsByTransaction */
    sumActiveReservations(_tx: unknown, opts: { transactionId: string; currencyCode: string }) {
      const sum = reservations
        .filter(
          (r) =>
            r.transactionId === opts.transactionId &&
            r.currencyCode === opts.currencyCode &&
            (r.state === "queued" || r.state === "processing"),
        )
        .reduce((acc, r) => acc + BigInt(r.amountMicros.split(".")[0] ?? "0"), 0n);
      return sum.toString();
    },

    /** Mock for sumRefundsByOriginalTransaction (committed refunds in ledger) */
    sumCommittedRefunds(_tx: unknown, opts: { originalTransactionId: string }) {
      const sum = ledgerEntries
        .filter((e) => e.entryType === "refund" && e.sourceId.startsWith(`tx:${opts.originalTransactionId}:`))
        .reduce((acc, e) => acc + BigInt(e.amountMicros.split(".")[0] ?? "0"), 0n);
      return sum.toString();
    },

    /** Mock for createPendingRefund */
    createReservation(_tx: unknown, data: { provider: string; idempotencyKey: string; transactionId: string; amountMicros: string; currencyCode: string }) {
      // Idempotent: return existing on conflict
      const existing = reservations.find(
        (r) => r.provider === data.provider && r.idempotencyKey === data.idempotencyKey,
      );
      if (existing) return existing as unknown as PendingRefund;

      const row = {
        pendingId: `pending-${++reservationCounter}`,
        provider: data.provider,
        idempotencyKey: data.idempotencyKey,
        transactionId: data.transactionId,
        amountMicros: data.amountMicros,
        currencyCode: data.currencyCode,
        state: "queued",
      };
      reservations.push(row);
      return row as unknown as PendingRefund;
    },

    /** Mock for appendLedgerEntryIdempotent */
    appendLedger(_tx: unknown, data: { provider: string; sourceId: string; entryType: string; amountMicros: string }) {
      const existing = ledgerEntries.find(
        (e) => e.provider === data.provider && e.sourceId === data.sourceId && e.entryType === data.entryType,
      );
      if (existing) return { row: existing as unknown as LedgerEntry, inserted: false };

      const row = {
        entryId: `entry-${++ledgerCounter}`,
        provider: data.provider,
        sourceId: data.sourceId,
        entryType: data.entryType,
        amountMicros: data.amountMicros,
      };
      ledgerEntries.push(row);
      return { row: row as unknown as LedgerEntry, inserted: true };
    },

    /** Mock for markCompleted */
    completeReservation(_tx: unknown, pendingId: string) {
      const r = reservations.find((x) => x.pendingId === pendingId);
      if (r) r.state = "completed";
      return r as unknown as PendingRefund;
    },

    /** Mock for markFailed */
    failReservation(_tx: unknown, pendingId: string) {
      const r = reservations.find((x) => x.pendingId === pendingId);
      if (r) r.state = "failed";
      return r as unknown as PendingRefund;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeRefund — reserve-then-reconcile correctness", () => {
  let store: ReturnType<typeof createRefundStore>;
  let adapter: ReturnType<typeof createFakeAdapter>;
  let registry: ProviderRegistry;
  let fakeDb: ReturnType<typeof createFakeDb>;
  let deps: RefundCoreDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createRefundStore();
    adapter = createFakeAdapter();
    registry = createFakeRegistry(adapter);
    fakeDb = createFakeDb();
    deps = { db: fakeDb.db, registry };

    // Wire store methods to mocks
    mockFindByProviderAndKey.mockImplementation(store.findReservation.bind(store));
    mockFindLedgerBySourceId.mockImplementation(store.findLedger.bind(store));
    mockSumActiveReservations.mockImplementation(store.sumActiveReservations.bind(store));
    mockSumRefunds.mockImplementation(store.sumCommittedRefunds.bind(store));
    mockCreatePendingRefund.mockImplementation(store.createReservation.bind(store));
    mockAppendIdempotent.mockImplementation(store.appendLedger.bind(store));
    mockMarkCompleted.mockImplementation(store.completeReservation.bind(store));
    mockMarkFailed.mockImplementation(store.failReservation.bind(store));
    mockApplyDelta.mockResolvedValue({ tenantId: TENANT_ID, currencyCode: "USD", currentBalanceMicros: "0" });
  });

  // ─── Basic flow ────────────────────────────────────────────────────────────

  it("refund #1 completes: reservation created, PSP called, ledger written, reservation completed", async () => {
    const result = await executeRefund(deps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 3000000n,
      idempotencyKey: "key-1",
      reason: "partial refund 1",
    });

    expect(result.state).toBe("completed");
    if (result.state === "completed") {
      expect(result.inserted).toBe(true);
    }
    // Reservation was created then completed
    expect(store.reservations).toHaveLength(1);
    expect(store.reservations[0]!.state).toBe("completed");
    // Ledger entry written
    expect(store.ledgerEntries).toHaveLength(1);
    expect(store.ledgerEntries[0]!.amountMicros).toBe("-3000000");
    // Balance debited
    expect(mockApplyDelta).toHaveBeenCalledOnce();
    // PSP was called
    expect(adapter.refund).toHaveBeenCalledOnce();
  });

  it("refund #2 with DIFFERENT idempotencyKey persists independently", async () => {
    const txRow = makeTxRow();

    // Refund #1
    const r1 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 3000000n,
      idempotencyKey: "key-1",
      reason: "partial refund 1",
    });
    expect(r1.state).toBe("completed");

    // Refund #2 — different key, different amount (3 + 4 = 7 < 10 original)
    const r2 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 4000000n,
      idempotencyKey: "key-2",
      reason: "partial refund 2",
    });

    expect(r2.state).toBe("completed");
    if (r2.state === "completed") {
      expect(r2.inserted).toBe(true);
    }
    // Two distinct ledger entries
    expect(store.ledgerEntries).toHaveLength(2);
    expect(store.ledgerEntries[1]!.amountMicros).toBe("-4000000");
    expect(mockApplyDelta).toHaveBeenCalledTimes(2);
  });

  // ─── Problem ① fix: dedup-before-gate ──────────────────────────────────────

  it("retry of FULL refund (same key) returns completed — NOT exceeds_remaining", async () => {
    const txRow = makeTxRow({ amountMicros: "5000000" }); // 5.00

    // First call — full refund succeeds
    const r1 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-full",
      reason: "full refund",
    });
    expect(r1.state).toBe("completed");

    // Retry — same key. Reservation exists with state='completed'.
    // Without dedup-before-gate, remaining would be 0 and this would return 400.
    const retry = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-full",
      reason: "full refund",
    });

    // CRITICAL: must return completed (dedup), NOT exceeds_remaining
    expect(retry.state).toBe("completed");
    if (retry.state === "completed") {
      expect(retry.inserted).toBe(false); // deduped
    }
    // PSP called only once (first attempt), not on retry
    expect(adapter.refund).toHaveBeenCalledOnce();
    // Only 1 ledger entry
    expect(store.ledgerEntries).toHaveLength(1);
    // applyDelta called only once
    expect(mockApplyDelta).toHaveBeenCalledOnce();
  });

  it("retry of partial refund (same key) deduplicates — no double-debit", async () => {
    const txRow = makeTxRow();

    // First call
    await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 3000000n,
      idempotencyKey: "key-1",
      reason: "partial refund 1",
    });

    // Retry — same key
    const retry = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 3000000n,
      idempotencyKey: "key-1",
      reason: "partial refund 1",
    });

    expect(retry.state).toBe("completed");
    if (retry.state === "completed") {
      expect(retry.inserted).toBe(false);
    }
    expect(store.ledgerEntries).toHaveLength(1);
    expect(mockApplyDelta).toHaveBeenCalledOnce();
  });

  // ─── Problem ② fix: reservation prevents PSP/ledger divergence ─────────────

  it("concurrent over-refund: second refund rejected at remaining gate (reservation counted)", async () => {
    const txRow = makeTxRow({ amountMicros: "8000000" }); // 8.00

    // Simulate: refund A (5.00) has already reserved but not yet finalized.
    // We pre-populate the store with an active reservation.
    store.reservations.push({
      pendingId: "pending-pre",
      provider: "stripe",
      idempotencyKey: "key-A",
      transactionId: TX_ID,
      amountMicros: "5000000",
      currencyCode: "USD",
      state: "queued", // active reservation
    });

    // Refund B (5.00) — total would be 10 > 8 original
    // Because A's reservation (5.00) counts toward remaining, B sees remaining = 8 - 5 = 3
    const result = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-B",
      reason: "concurrent refund B",
    });

    expect(result.state).toBe("exceeds_remaining");
    if (result.state === "exceeds_remaining") {
      expect(result.remaining).toBe(3000000n); // 8M - 5M reserved
      expect(result.requested).toBe(5000000n);
    }
    // PSP must NOT be called — rejected before provider interaction
    expect(adapter.refund).not.toHaveBeenCalled();
  });

  it("mutation test: adapter.refund is NOT called before reservation is committed", async () => {
    // This test verifies the ordering invariant: reservation MUST be written
    // before the PSP is called. We verify by checking that createPendingRefund
    // is called before adapter.refund in the execution sequence.
    const callOrder: string[] = [];

    mockCreatePendingRefund.mockImplementation((...args: unknown[]) => {
      callOrder.push("createPendingRefund");
      return store.createReservation(...(args as [unknown, { provider: string; idempotencyKey: string; transactionId: string; amountMicros: string; currencyCode: string }]));
    });

    adapter.refund.mockImplementation(async () => {
      callOrder.push("adapter.refund");
      return { state: "completed", providerRefundId: "prov-1" } as RefundResult;
    });

    await executeRefund(deps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 1000000n,
      idempotencyKey: "key-order",
      reason: "order test",
    });

    // Reservation MUST be created before PSP call
    const reserveIdx = callOrder.indexOf("createPendingRefund");
    const adapterIdx = callOrder.indexOf("adapter.refund");
    expect(reserveIdx).toBeGreaterThanOrEqual(0);
    expect(adapterIdx).toBeGreaterThanOrEqual(0);
    expect(reserveIdx).toBeLessThan(adapterIdx);
  });

  // ─── PSP failure releases headroom ─────────────────────────────────────────

  it("PSP failure after reservation → reservation marked failed, headroom released", async () => {
    const failAdapter = createFakeAdapter({ state: "failed", error: { message: "Insufficient funds" } } as RefundResult);
    const failRegistry = createFakeRegistry(failAdapter);
    const failDeps: RefundCoreDeps = { db: fakeDb.db, registry: failRegistry };

    const result = await executeRefund(failDeps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 3000000n,
      idempotencyKey: "key-fail",
      reason: "will fail",
    });

    expect(result.state).toBe("failed");
    // Reservation was created then marked failed
    expect(store.reservations).toHaveLength(1);
    expect(store.reservations[0]!.state).toBe("failed");

    // Subsequent refund for same amount succeeds (headroom was released)
    const successAdapter = createFakeAdapter();
    const successRegistry = createFakeRegistry(successAdapter);
    const successDeps: RefundCoreDeps = { db: fakeDb.db, registry: successRegistry };

    const r2 = await executeRefund(successDeps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 3000000n,
      idempotencyKey: "key-after-fail",
      reason: "retry after fail",
    });

    expect(r2.state).toBe("completed");
  });

  it("PSP throws error → reservation marked failed, headroom released", async () => {
    const throwAdapter = { refund: vi.fn().mockRejectedValue(new Error("Network timeout")) };
    const throwRegistry = createFakeRegistry(throwAdapter);
    const throwDeps: RefundCoreDeps = { db: fakeDb.db, registry: throwRegistry };

    const result = await executeRefund(throwDeps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 2000000n,
      idempotencyKey: "key-throw",
      reason: "will throw",
    });

    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.code).toBe("PROVIDER_REFUND_ERROR");
    }
    expect(store.reservations[0]!.state).toBe("failed");
  });

  // ─── Over-refund without concurrency ───────────────────────────────────────

  it("over-refund is rejected with exceeds_remaining — adapter NOT called", async () => {
    const txRow = makeTxRow({ amountMicros: "5000000" }); // 5.00

    const result = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 6000000n, // 6.00 > 5.00
      idempotencyKey: "key-over",
      reason: "too much",
    });

    expect(result.state).toBe("exceeds_remaining");
    if (result.state === "exceeds_remaining") {
      expect(result.remaining).toBe(5000000n);
      expect(result.requested).toBe(6000000n);
    }
    expect(adapter.refund).not.toHaveBeenCalled();
  });

  // ─── Full refund marks tx refunded ─────────────────────────────────────────

  it("full refund marks tx status as refunded", async () => {
    const txRow = makeTxRow({ amountMicros: "5000000" }); // 5.00

    const result = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-full",
      reason: "full refund",
    });

    expect(result.state).toBe("completed");
    if (result.state === "completed") {
      expect(result.inserted).toBe(true);
    }
    expect(fakeDb.txStatusUpdates.some((u) => u.status === "refunded")).toBe(true);
  });

  // ─── Pending / pending_webhook paths ───────────────────────────────────────

  it("PSP returns pending → reservation stays active, returns pending state", async () => {
    const pendingAdapter = createFakeAdapter({ state: "pending", providerRefundId: "zp-ref-1" } as RefundResult);
    const pendingRegistry = createFakeRegistry(pendingAdapter);
    const pendingDeps: RefundCoreDeps = { db: fakeDb.db, registry: pendingRegistry };

    const result = await executeRefund(pendingDeps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 2000000n,
      idempotencyKey: "key-pending",
      reason: "zalopay refund",
    });

    expect(result.state).toBe("pending");
    if (result.state === "pending") {
      expect(result.pendingId).toBe("pending-1");
    }
    // Reservation stays queued (not completed, not failed)
    expect(store.reservations[0]!.state).toBe("queued");
    // No ledger entry yet
    expect(store.ledgerEntries).toHaveLength(0);
  });

  it("PSP returns pending_webhook → tx status updated, reservation stays active", async () => {
    const webhookAdapter = createFakeAdapter({
      state: "pending_webhook",
      error: { providerCode: "NP-001" },
    } as unknown as RefundResult);
    const webhookRegistry = createFakeRegistry(webhookAdapter);
    const webhookDeps: RefundCoreDeps = { db: fakeDb.db, registry: webhookRegistry };

    const result = await executeRefund(webhookDeps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 2000000n,
      idempotencyKey: "key-webhook",
      reason: "nowpayments refund",
    });

    expect(result.state).toBe("pending_webhook");
    if (result.state === "pending_webhook") {
      expect(result.transactionId).toBe(TX_ID);
      expect(result.providerCode).toBe("NP-001");
    }
    expect(fakeDb.txStatusUpdates.some((u) => u.status === "refund_pending_webhook")).toBe(true);
    // Reservation stays queued
    expect(store.reservations[0]!.state).toBe("queued");
  });

  // ─── Provider unknown ──────────────────────────────────────────────────────

  it("unknown provider returns provider_unknown without any DB interaction", async () => {
    const emptyRegistry = { get: () => undefined } as unknown as ProviderRegistry;
    const emptyDeps: RefundCoreDeps = { db: fakeDb.db, registry: emptyRegistry };

    const result = await executeRefund(emptyDeps, ADMIN_ACTOR, {
      txRow: makeTxRow({ provider: "nonexistent" }),
      amountMicros: 1000000n,
      idempotencyKey: "key-x",
      reason: "test",
    });

    expect(result.state).toBe("provider_unknown");
  });

  // ─── DB-level sum verification ─────────────────────────────────────────────

  it("sumRefundsByOriginalTransaction + sumActiveReservations called with correct params", async () => {
    await executeRefund(deps, ADMIN_ACTOR, {
      txRow: makeTxRow(),
      amountMicros: 1000000n,
      idempotencyKey: "key-check",
      reason: "verify DB sum",
    });

    expect(mockSumRefunds).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: TENANT_ID, currencyCode: "USD", originalTransactionId: TX_ID },
    );
    expect(mockSumActiveReservations).toHaveBeenCalledWith(
      expect.anything(),
      { transactionId: TX_ID, currencyCode: "USD" },
    );
  });
});
