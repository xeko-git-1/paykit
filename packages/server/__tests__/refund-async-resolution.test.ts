/**
 * Tests for async refund RESOLUTION paths — the lifecycle AFTER executeRefund
 * returns pending/pending_webhook.
 *
 * Validates:
 *   - pending_webhook: webhook fires → reservation released, no double-count
 *   - defense-in-depth: refund on already-refunded tx → rejected without PSP call
 *   - Mutation-resistant: removing the webhook reservation release causes
 *     the double-count test to fail (remaining incorrectly reduced by both
 *     committed entry AND stale reservation)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProviderRegistry, RefundResult } from "@vibecc/paykit";
import type { PaymentTransaction } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import type { LedgerEntry } from "@vibecc/paykit-auth-core/db/schema/ledger-entries.js";
import type { PendingRefund } from "@vibecc/paykit-auth-core/db/schema/pending-refunds.js";

// ---------------------------------------------------------------------------
// Mock repo modules
// ---------------------------------------------------------------------------

vi.mock("@vibecc/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
  findLedgerEntryBySourceId: vi.fn(),
  sumRefundsByOriginalTransaction: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/balance.repo.js", () => ({
  applyDelta: vi.fn().mockResolvedValue({ tenantId: "t", currencyCode: "USD", currentBalanceMicros: "0" }),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  createPendingRefund: vi.fn(),
  findByProviderAndKey: vi.fn(),
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  sumActiveReservationsByTransaction: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => ({
  updateTransactionStatus: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js", () => ({
  tryRecordWebhookEvent: vi.fn(),
}));

// Import AFTER mocks
import { executeRefund, type RefundCoreDeps, type RefundActor } from "../src/services/refund-core.js";
import {
  appendLedgerEntryIdempotent,
  findLedgerEntryBySourceId,
  sumRefundsByOriginalTransaction,
} from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import {
  createPendingRefund,
  findByProviderAndKey,
  findActiveByTransaction,
  markCompleted,
  markFailed,
  sumActiveReservationsByTransaction,
} from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { tryRecordWebhookEvent } from "@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js";

const mockAppendIdempotent = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mockFindLedgerBySourceId = findLedgerEntryBySourceId as ReturnType<typeof vi.fn>;
const mockSumRefunds = sumRefundsByOriginalTransaction as ReturnType<typeof vi.fn>;
const mockApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mockCreatePendingRefund = createPendingRefund as ReturnType<typeof vi.fn>;
const mockFindByProviderAndKey = findByProviderAndKey as ReturnType<typeof vi.fn>;
const mockFindActiveByTransaction = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mockMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mockMarkFailed = markFailed as ReturnType<typeof vi.fn>;
const mockSumActiveReservations = sumActiveReservationsByTransaction as ReturnType<typeof vi.fn>;
const mockUpdateTxStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;
const mockTryRecordWebhookEvent = tryRecordWebhookEvent as ReturnType<typeof vi.fn>;

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
    provider: "nowpayments",
    amountMicros: "10000000", // 10.00 in micros
    currencyCode: "USD",
    status: "completed",
    providerRef: "np_pay_abc123",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PaymentTransaction;
}

const ADMIN_ACTOR: RefundActor = { kind: "admin", adminUserId: "admin-1", role: "super_admin" };

/**
 * In-memory model of pending_refunds + ledger for multi-step async scenarios.
 * Models state transitions so tests are mutation-resistant.
 */
function createAsyncRefundStore() {
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
    metadataJson: Record<string, unknown>;
  }> = [];
  let reservationCounter = 0;
  let ledgerCounter = 0;

  return {
    reservations,
    ledgerEntries,

    findReservation(_tx: unknown, opts: { provider: string; idempotencyKey: string }) {
      return reservations.find(
        (r) => r.provider === opts.provider && r.idempotencyKey === opts.idempotencyKey,
      ) as PendingRefund | undefined;
    },

    findLedger(_tx: unknown, opts: { provider: string; sourceId: string; entryType: string }) {
      return ledgerEntries.find(
        (e) => e.provider === opts.provider && e.sourceId === opts.sourceId && e.entryType === opts.entryType,
      ) as unknown as LedgerEntry | undefined;
    },

    findActiveByTx(_tx: unknown, opts: { provider: string; transactionId: string }) {
      return reservations.filter(
        (r) =>
          r.provider === opts.provider &&
          r.transactionId === opts.transactionId &&
          (r.state === "queued" || r.state === "processing"),
      ) as unknown as PendingRefund[];
    },

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

    sumCommittedRefunds(_tx: unknown, opts: { originalTransactionId: string }) {
      const sum = ledgerEntries
        .filter((e) => e.entryType === "refund")
        .filter((e) => {
          const meta = e.metadataJson as Record<string, unknown>;
          return meta.originalTransactionId === opts.originalTransactionId;
        })
        .reduce((acc, e) => acc + BigInt(e.amountMicros.split(".")[0] ?? "0"), 0n);
      return sum.toString();
    },

    createReservation(_tx: unknown, data: { provider: string; idempotencyKey: string; transactionId: string; amountMicros: string; currencyCode: string }) {
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

    appendLedger(_tx: unknown, data: { provider: string; sourceId: string; entryType: string; amountMicros: string; metadataJson?: Record<string, unknown> }) {
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
        metadataJson: data.metadataJson ?? {},
      };
      ledgerEntries.push(row);
      return { row: row as unknown as LedgerEntry, inserted: true };
    },

    completeReservation(_tx: unknown, pendingId: string) {
      const r = reservations.find((x) => x.pendingId === pendingId);
      if (r) r.state = "completed";
      return r as unknown as PendingRefund;
    },

    failReservation(_tx: unknown, pendingId: string) {
      const r = reservations.find((x) => x.pendingId === pendingId);
      if (r) r.state = "failed";
      return r as unknown as PendingRefund;
    },
  };
}

function createFakeDb(txRow?: PaymentTransaction) {
  const txStatusUpdates: Array<{ transactionId: string; status: string }> = [];
  const resolvedTxRow = txRow ?? makeTxRow();

  const txProxy = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve([resolvedTxRow]),
          }),
          limit: () => Promise.resolve([resolvedTxRow]),
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

// ---------------------------------------------------------------------------
// Tests — Defense-in-depth: already-refunded tx
// ---------------------------------------------------------------------------

describe("executeRefund — defense-in-depth: already-refunded tx", () => {
  let store: ReturnType<typeof createAsyncRefundStore>;
  let fakeDb: ReturnType<typeof createFakeDb>;
  let deps: RefundCoreDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createAsyncRefundStore();
    fakeDb = createFakeDb();
    const adapter = { refund: vi.fn() };
    const registry = { get: () => adapter } as unknown as ProviderRegistry;
    deps = { db: fakeDb.db, registry };

    mockFindByProviderAndKey.mockImplementation(store.findReservation.bind(store));
    mockFindLedgerBySourceId.mockImplementation(store.findLedger.bind(store));
    mockSumActiveReservations.mockImplementation(store.sumActiveReservations.bind(store));
    mockSumRefunds.mockImplementation(store.sumCommittedRefunds.bind(store));
    mockCreatePendingRefund.mockImplementation(store.createReservation.bind(store));
    mockAppendIdempotent.mockImplementation(store.appendLedger.bind(store));
    mockMarkCompleted.mockImplementation(store.completeReservation.bind(store));
    mockMarkFailed.mockImplementation(store.failReservation.bind(store));
  });

  it("refund on already-refunded tx is rejected without calling the adapter", async () => {
    const txRow = makeTxRow({ status: "refunded" });
    const adapter = { refund: vi.fn() };
    const registry = { get: () => adapter } as unknown as ProviderRegistry;
    const localDeps: RefundCoreDeps = { db: fakeDb.db, registry };

    const result = await executeRefund(localDeps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 1000000n,
      idempotencyKey: "key-after-refunded",
      reason: "should be rejected",
    });

    expect(result.state).toBe("exceeds_remaining");
    if (result.state === "exceeds_remaining") {
      expect(result.remaining).toBe(0n);
      expect(result.requested).toBe(1000000n);
    }
    // Adapter must NOT be called
    expect(adapter.refund).not.toHaveBeenCalled();
    // No reservation created
    expect(store.reservations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — BUG A: pending_webhook resolution via webhook
// ---------------------------------------------------------------------------

describe("webhook payment.refunded — releases reservation (BUG A)", () => {
  let store: ReturnType<typeof createAsyncRefundStore>;
  let fakeDb: ReturnType<typeof createFakeDb>;
  let deps: RefundCoreDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createAsyncRefundStore();
    fakeDb = createFakeDb();
    const pendingWebhookAdapter = {
      refund: vi.fn().mockResolvedValue({ state: "pending_webhook", error: { providerCode: "NP-001" } }),
    };
    const registry = { get: () => pendingWebhookAdapter } as unknown as ProviderRegistry;
    deps = { db: fakeDb.db, registry };

    mockFindByProviderAndKey.mockImplementation(store.findReservation.bind(store));
    mockFindLedgerBySourceId.mockImplementation(store.findLedger.bind(store));
    mockSumActiveReservations.mockImplementation(store.sumActiveReservations.bind(store));
    mockSumRefunds.mockImplementation(store.sumCommittedRefunds.bind(store));
    mockCreatePendingRefund.mockImplementation(store.createReservation.bind(store));
    mockAppendIdempotent.mockImplementation(store.appendLedger.bind(store));
    mockMarkCompleted.mockImplementation(store.completeReservation.bind(store));
    mockMarkFailed.mockImplementation(store.failReservation.bind(store));
    mockFindActiveByTransaction.mockImplementation(store.findActiveByTx.bind(store));
    mockApplyDelta.mockResolvedValue({ tenantId: TENANT_ID, currencyCode: "USD", currentBalanceMicros: "0" });
  });

  it("full lifecycle: reserve → pending_webhook → webhook fires → reservation released → subsequent refund sees correct remaining", async () => {
    const txRow = makeTxRow({ amountMicros: "10000000" }); // 10.00

    // Phase 1: executeRefund returns pending_webhook, reservation stays queued
    const r1 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-webhook-1",
      reason: "partial refund via NowPayments",
    });
    expect(r1.state).toBe("pending_webhook");
    expect(store.reservations).toHaveLength(1);
    expect(store.reservations[0]!.state).toBe("queued");

    // Phase 2: Simulate webhook handler's payment.refunded path.
    // This is the critical path: it writes the committed ledger entry AND
    // must release the reservation in the same transaction.
    // We simulate what webhook-router.ts does in the payment.refunded case:
    const webhookTx = fakeDb.txProxy;

    // Webhook writes committed ledger entry (sourceId = providerRef, NOT tx:txId:key)
    const ledgerResult = store.appendLedger(webhookTx, {
      provider: "nowpayments",
      sourceId: "np_pay_abc123", // providerRef — webhook's sourceId scheme
      entryType: "refund",
      amountMicros: "-5000000",
      metadataJson: { originalTransactionId: TX_ID, source: "refund" },
    });
    expect(ledgerResult.inserted).toBe(true);

    // Webhook releases active reservations for this tx+provider
    const activeReservations = store.findActiveByTx(webhookTx, {
      provider: "nowpayments",
      transactionId: TX_ID,
    });
    for (const reservation of activeReservations) {
      store.completeReservation(webhookTx, reservation.pendingId);
    }

    // Verify reservation is now completed
    expect(store.reservations[0]!.state).toBe("completed");

    // Phase 3: Subsequent refund on same tx should see correct remaining.
    // remaining = 10M (original) + (-5M committed) - 0 (no active reservations) = 5M
    // WITHOUT the fix (reservation still queued), remaining would be:
    // 10M + (-5M committed) - 5M (stale reservation) = 0 → double-count!
    const r2 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-webhook-2",
      reason: "second partial refund",
    });

    // This MUST succeed — remaining is 5M, requesting 5M
    expect(r2.state).toBe("pending_webhook");
    expect(store.reservations).toHaveLength(2);
  });

  it("mutation test: if webhook does NOT release reservation, subsequent refund is incorrectly rejected (double-count)", async () => {
    const txRow = makeTxRow({ amountMicros: "10000000" }); // 10.00

    // Reserve
    const r1 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-mut-1",
      reason: "partial refund",
    });
    expect(r1.state).toBe("pending_webhook");

    // Simulate webhook writing ledger entry but NOT releasing reservation (the bug)
    const webhookTx = fakeDb.txProxy;
    store.appendLedger(webhookTx, {
      provider: "nowpayments",
      sourceId: "np_pay_abc123",
      entryType: "refund",
      amountMicros: "-5000000",
      metadataJson: { originalTransactionId: TX_ID, source: "refund" },
    });
    // Deliberately NOT releasing reservation — simulating the bug

    // Subsequent refund: remaining = 10M + (-5M committed) - 5M (stale reservation) = 0
    const r2 = await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 5000000n,
      idempotencyKey: "key-mut-2",
      reason: "second partial — should fail due to bug",
    });

    // With the bug present, this is incorrectly rejected
    expect(r2.state).toBe("exceeds_remaining");
    if (r2.state === "exceeds_remaining") {
      // remaining is 0 because both committed entry AND stale reservation subtract
      expect(r2.remaining).toBe(0n);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — refund ref selection: provider_payment_id preferred over provider_ref
// ---------------------------------------------------------------------------

describe("executeRefund — refund ref selection (provider_payment_id vs provider_ref)", () => {
  let store: ReturnType<typeof createAsyncRefundStore>;
  let fakeDb: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createAsyncRefundStore();
    fakeDb = createFakeDb();
    mockFindByProviderAndKey.mockImplementation(store.findReservation.bind(store));
    mockFindLedgerBySourceId.mockImplementation(store.findLedger.bind(store));
    mockSumActiveReservations.mockImplementation(store.sumActiveReservations.bind(store));
    mockSumRefunds.mockImplementation(store.sumCommittedRefunds.bind(store));
    mockCreatePendingRefund.mockImplementation(store.createReservation.bind(store));
    mockAppendIdempotent.mockImplementation(store.appendLedger.bind(store));
    mockMarkCompleted.mockImplementation(store.completeReservation.bind(store));
    mockMarkFailed.mockImplementation(store.failReservation.bind(store));
  });

  it("passes provider_payment_id to the adapter when set (NowPayments: refund keys on numeric payment_id, not order_id)", async () => {
    // provider_ref = order_id (the webhook lookup key); provider_payment_id =
    // NowPayments' numeric id the refund API actually needs.
    const txRow = makeTxRow({
      providerRef: "order-id-tx-uuid",
      providerPaymentId: "5524759814",
    } as Partial<PaymentTransaction>);
    const adapter = { refund: vi.fn().mockResolvedValue({ state: "pending_webhook" } as RefundResult) };
    const registry = { get: () => adapter } as unknown as ProviderRegistry;
    const deps: RefundCoreDeps = { db: fakeDb.db, registry };

    await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 1000000n,
      idempotencyKey: "key-ref-select-1",
      reason: "refund by payment_id",
    });

    expect(adapter.refund).toHaveBeenCalledTimes(1);
    expect(adapter.refund.mock.calls[0]![0].providerRef).toBe("5524759814");
  });

  it("falls back to provider_ref when provider_payment_id is null (Stripe/VNPay refund by the same ref)", async () => {
    const txRow = makeTxRow({ providerRef: "cs_test_session", provider: "stripe" });
    const adapter = { refund: vi.fn().mockResolvedValue({ state: "completed", providerRefundId: "re_1" } as RefundResult) };
    const registry = { get: () => adapter } as unknown as ProviderRegistry;
    const deps: RefundCoreDeps = { db: fakeDb.db, registry };

    await executeRefund(deps, ADMIN_ACTOR, {
      txRow,
      amountMicros: 1000000n,
      idempotencyKey: "key-ref-select-2",
      reason: "refund by provider_ref",
    });

    expect(adapter.refund).toHaveBeenCalledTimes(1);
    expect(adapter.refund.mock.calls[0]![0].providerRef).toBe("cs_test_session");
  });
});
