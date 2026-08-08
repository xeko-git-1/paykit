/**
 * Webhook payment.refunded E2E — drives the REAL router, not a re-implementation
 * of its internals.
 *
 * What this file guards has changed shape. It used to assert that a refund event
 * moves the payment to `refunded`, using a 1_000_000 refund against a 5_000_000
 * payment — encoding the very defect that made a 20% refund read downstream as
 * fully refunded, and that then made the remaining 80% unrefundable because the
 * refund gate turns away a `refunded` payment.
 *
 * So the assertions now follow the refunded TOTAL: a partial refund lands on
 * `partially_refunded`, and only a total that reaches the captured amount lands on
 * `refunded`. The ledger entry is keyed on the refund's own identity rather than
 * the payment's, which is what lets a second partial refund exist at all.
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
} from "@vibecc/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The router records every delivery in the inbox before processing it, so this
// stands in for that repo. The factory is async so the shared helper can be pulled
// in from inside it — a hoisted factory cannot reach a top-level import.
vi.mock("@vibecc/paykit-auth-core/db/repos/webhook-inbox.repo.js", async () => {
  const { inboxRepoMock } = await import("./helpers/webhook-inbox-repo-mock.js");
  return inboxRepoMock();
});
vi.mock("@vibecc/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
  sumRefundsByOriginalTransaction: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/balance.repo.js", () => ({
  applyDelta: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => ({
  updateTransactionStatus: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/refund.repo.js", () => ({
  createRefund: vi.fn(),
  findByProviderRefundId: vi.fn(),
  markSucceeded: vi.fn(),
}));

import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import {
  appendLedgerEntryIdempotent,
  sumRefundsByOriginalTransaction,
} from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import {
  findActiveByTransaction,
  markCompleted,
} from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import {
  createRefund,
  findByProviderRefundId,
  markSucceeded,
} from "@vibecc/paykit-auth-core/db/repos/refund.repo.js";
import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";

const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mFindActive = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;
const mCreateRefund = createRefund as ReturnType<typeof vi.fn>;
const mFindByRefundId = findByProviderRefundId as ReturnType<typeof vi.fn>;
const mMarkSucceeded = markSucceeded as ReturnType<typeof vi.fn>;
/**
 * The refunded total comes from the LEDGER, not from the refund table, so the
 * admin path and this path agree: the admin path writes a ledger entry without a
 * refund row, and summing the refund table would miss it and under-report how much
 * has been returned. Ledger refund entries are stored negative, hence the signs in
 * the values these tests return.
 */
const mSumRefunded = sumRefundsByOriginalTransaction as ReturnType<typeof vi.fn>;

const TX_ID = "a0000000-0000-4000-8000-000000000001";
const REFUND_ID = "d0000000-0000-4000-8000-00000000000d";
const ENTRY_ID = "e0000000-0000-4000-8000-00000000000e";

/** A 5_000_000-micro payment, credited and therefore refundable. */
const TX_ROW = {
  transactionId: TX_ID,
  tenantId: "tenant-1",
  ownerId: "owner-1",
  provider: "sepay",
  amountMicros: "5000000",
  currencyCode: "VND",
  status: "completed",
  providerRef: "prov-ref-1",
};

let event: NormalizedWebhookEvent;

/** A refund of `micros`, optionally named by the provider. */
function refundEvent(micros: string, providerRefundId?: string): NormalizedWebhookEvent {
  return {
    type: "payment.refunded",
    eventId: `evt-refund-${micros}`,
    providerRef: "prov-ref-1",
    refundAmountMicros: micros,
    currencyCode: "VND",
    ...(providerRefundId !== undefined ? { providerRefundId } : {}),
    metadata: {},
  } as NormalizedWebhookEvent;
}

function chainable(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.for = () => chain;
  chain.limit = async () => rows;
  return chain;
}

function makeDb(txRow: Record<string, unknown> = TX_ROW) {
  return {
    select: () => chainable([txRow]),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: () => chainable([txRow]) }),
  } as never;
}

function buildApp(txRow: Record<string, unknown> = TX_ROW) {
  const adapter = {
    id: "sepay",
    displayName: "SePay",
    supportedCurrencies: ["VND"],
    checkoutMode: "qr",
    createCheckout: async () => {
      throw new Error("unused");
    },
    verifyWebhookSignature: () => true,
    parseWebhookPayload: () => event,
    refund: async () => ({ state: "unsupported", reason: "unused" }),
    fetchTransactions: async () => [],
  } as PaymentProviderAdapter;
  const registry = {
    get: (id: string) => (id === adapter.id ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
  return buildWebhookRouter({ db: makeDb(txRow), registry, events: {} });
}

function post(txRow: Record<string, unknown> = TX_ROW) {
  return buildApp(txRow).request(
    new Request("http://localhost/sepay", { method: "POST", body: "{}" }),
  );
}

beforeEach(() => {
  event = refundEvent("1000000");
  mAppend.mockReset().mockResolvedValue({ row: { entryId: ENTRY_ID }, inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mFindActive
    .mockReset()
    .mockResolvedValue([{ pendingId: "pending-1" }, { pendingId: "pending-2" }]);
  mMarkCompleted.mockReset().mockResolvedValue(undefined);
  mUpdateStatus.mockReset().mockImplementation(async (_tx, transactionId, status) => ({
    ...TX_ROW,
    transactionId,
    status,
  }));
  mCreateRefund
    .mockReset()
    .mockResolvedValue({ row: { refundId: REFUND_ID, status: "requested" }, created: true });
  mFindByRefundId.mockReset().mockResolvedValue(undefined);
  mMarkSucceeded.mockReset().mockResolvedValue({ refundId: REFUND_ID, status: "succeeded" });
  // Refunded total AFTER this refund settled — the handler reads it back.
  mSumRefunded.mockReset().mockResolvedValue("-1000000");
});

describe("webhook payment.refunded — the money move", () => {
  it("writes a negative ledger entry and debits the wallet", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(mAppend).toHaveBeenCalledTimes(1);
    expect(mAppend.mock.calls[0]?.[1]).toMatchObject({
      entryType: "refund",
      amountMicros: "-1000000",
      currencyCode: "VND",
    });
    expect(mApplyDelta).toHaveBeenCalledWith(expect.anything(), "tenant-1", "VND", -1000000n);
  });

  it("keys the ledger entry on the refund, not on the payment", async () => {
    event = refundEvent("1000000", "re_abc");
    await post();
    const sourceId = (mAppend.mock.calls[0]?.[1] as { sourceId: string }).sourceId;
    // Keying on the payment reference is what made the SECOND partial refund
    // collide with the first and lose its balance move.
    expect(sourceId).toContain("re_abc");
    expect(sourceId).not.toBe("prov-ref-1");
  });

  it("does not debit the wallet again when the ledger entry already existed", async () => {
    mAppend.mockResolvedValue({ row: { entryId: ENTRY_ID }, inserted: false });
    await post();
    expect(mApplyDelta).not.toHaveBeenCalled();
  });

  it("releases the reservations the payment was holding", async () => {
    await post();
    expect(mFindActive).toHaveBeenCalledTimes(1);
    expect(mMarkCompleted).toHaveBeenCalledTimes(2);
    expect(mMarkCompleted).toHaveBeenCalledWith(expect.anything(), "pending-1");
    expect(mMarkCompleted).toHaveBeenCalledWith(expect.anything(), "pending-2");
  });

  it("binds the refund to the ledger row that moved the money", async () => {
    await post();
    expect(mMarkSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refundId: REFUND_ID, ledgerEntryId: ENTRY_ID }),
    );
  });
});

describe("webhook payment.refunded — the resulting payment status", () => {
  it("is partially_refunded when the refunded total is below the captured amount", async () => {
    mSumRefunded.mockResolvedValue("-1000000"); // of 5_000_000
    await post();
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "partially_refunded");
  });

  it("is refunded once the refunded total reaches the captured amount", async () => {
    event = refundEvent("4000000");
    mSumRefunded.mockResolvedValue("-5000000");
    await post();
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "refunded");
  });

  it("is refunded when a provider returns marginally more than was captured", async () => {
    // Providers do occasionally return a rounding unit extra. Treating that as a
    // defect would strand the payment in partially_refunded forever.
    mSumRefunded.mockResolvedValue("-5000001");
    await post();
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "refunded");
  });
});

describe("webhook payment.refunded — events that must not move money", () => {
  it("ignores a refund whose currency is not the payment's", async () => {
    // Wallets are keyed (tenant, currency): a mismatched refund would debit a
    // different wallet than the one the payment credited.
    event = { ...refundEvent("1000000"), currencyCode: "USD" } as NormalizedWebhookEvent;
    const res = await post();
    expect(res.status).toBe(200);
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
    expect(mUpdateStatus).not.toHaveBeenCalled();
  });

  it("ignores a refund for a payment that was never credited", async () => {
    const res = await post({ ...TX_ROW, status: "pending" });
    expect(res.status).toBe(200);
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
  });

  it("ignores a refund for a quarantined payment", async () => {
    // Quarantine means the money was deliberately withheld from the wallet;
    // refunding it would debit money that was never credited.
    const res = await post({ ...TX_ROW, status: "quarantine" });
    expect(res.status).toBe(200);
    expect(mAppend).not.toHaveBeenCalled();
  });

  it("accepts a further refund on an already partially-refunded payment", async () => {
    mSumRefunded.mockResolvedValue("-2000000");
    await post({ ...TX_ROW, status: "partially_refunded" });
    expect(mAppend).toHaveBeenCalledTimes(1);
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "partially_refunded");
  });

  it("ignores a redelivery of a refund already recorded as succeeded", async () => {
    event = refundEvent("1000000", "re_dup");
    mFindByRefundId.mockResolvedValue({ refundId: REFUND_ID, status: "succeeded" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
  });

  it("does not move money twice when the refund row was already settled", async () => {
    mCreateRefund.mockResolvedValue({
      row: { refundId: REFUND_ID, status: "succeeded" },
      created: false,
    });
    await post();
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
  });

  it("leaves the payment status alone when another delivery settled the refund first", async () => {
    mMarkSucceeded.mockResolvedValue(undefined);
    await post();
    expect(mUpdateStatus).not.toHaveBeenCalled();
  });

  it("ignores an event carrying no refund amount", async () => {
    event = { ...refundEvent("1000000"), refundAmountMicros: undefined } as NormalizedWebhookEvent;
    const res = await post();
    expect(res.status).toBe(200);
    expect(mAppend).not.toHaveBeenCalled();
  });
});
