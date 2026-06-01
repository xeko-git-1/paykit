/**
 * Webhook payment.refunded E2E test — drives the REAL buildWebhookRouter
 * (not a hand-simulation of its internals).
 *
 * The prior async-resolution test reproduced the payment.refunded logic
 * inline, so deleting the router's reservation-release loop failed no test.
 * This test sends a signed IPN through the actual router and asserts the
 * observable effects: ledger refund_debit written, balance debited, active
 * reservations released (markCompleted), and status → 'refunded'. Removing the
 * release loop makes the markCompleted assertion fail.
 */
import type { NormalizedWebhookEvent, PaymentProviderAdapter, ProviderRegistry } from "@vibecc/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/repos/webhook-event.repo.js", () => ({
  tryRecordWebhookEvent: vi.fn(),
}));
vi.mock("../src/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
}));
vi.mock("../src/db/repos/balance.repo.js", () => ({
  applyDelta: vi.fn(),
}));
vi.mock("../src/db/repos/pending-refund.repo.js", () => ({
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
}));
vi.mock("../src/db/repos/payment.repo.js", () => ({
  updateTransactionStatus: vi.fn(),
}));

import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";
import { tryRecordWebhookEvent } from "../src/db/repos/webhook-event.repo.js";
import { appendLedgerEntryIdempotent } from "../src/db/repos/ledger.repo.js";
import { applyDelta } from "../src/db/repos/balance.repo.js";
import { findActiveByTransaction, markCompleted } from "../src/db/repos/pending-refund.repo.js";
import { updateTransactionStatus } from "../src/db/repos/payment.repo.js";

const mTryRecord = tryRecordWebhookEvent as ReturnType<typeof vi.fn>;
const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mFindActive = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;

const TX_ROW = {
  transactionId: "a0000000-0000-4000-8000-000000000001",
  tenantId: "tenant-1",
  ownerId: "owner-1",
  provider: "sepay",
  amountMicros: "5000000",
  currencyCode: "VND",
  status: "completed",
  providerRef: "prov-ref-1",
};

const REFUND_EVENT: NormalizedWebhookEvent = {
  type: "payment.refunded",
  eventId: "evt-refund-1",
  providerRef: "prov-ref-1",
  refundAmountMicros: "1000000",
  currencyCode: "VND",
  metadata: {},
} as NormalizedWebhookEvent;

// A chainable query stub: select().from().where().for().limit() and the
// post-commit select().from().where().limit() both resolve to [TX_ROW].
function chainable(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.for = () => chain;
  chain.limit = async () => rows;
  return chain;
}

function makeDb() {
  return {
    select: () => chainable([TX_ROW]),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: () => chainable([TX_ROW]) }),
  } as never;
}

function makeAdapter(): PaymentProviderAdapter {
  return {
    id: "sepay",
    displayName: "SePay",
    supportedCurrencies: ["VND"],
    checkoutMode: "qr",
    createCheckout: async () => {
      throw new Error("unused");
    },
    verifyWebhookSignature: () => true,
    parseWebhookPayload: () => REFUND_EVENT,
    refund: async () => ({ state: "unsupported", reason: "unused" }),
    fetchTransactions: async () => [],
  } as PaymentProviderAdapter;
}

function buildApp() {
  const adapter = makeAdapter();
  const registry = {
    get: (id: string) => (id === adapter.id ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
  return buildWebhookRouter({ db: makeDb(), registry, events: {} });
}

beforeEach(() => {
  mTryRecord.mockReset().mockResolvedValue({ recorded: true });
  mAppend.mockReset().mockResolvedValue({ inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mFindActive.mockReset().mockResolvedValue([{ pendingId: "pending-1" }, { pendingId: "pending-2" }]);
  mMarkCompleted.mockReset().mockResolvedValue(undefined);
  mUpdateStatus.mockReset().mockResolvedValue({ ...TX_ROW, status: "refunded" });
});

describe("webhook payment.refunded — real router path (mutation-resistant)", () => {
  it("writes a refund_debit ledger entry and debits the balance", async () => {
    const app = buildApp();
    const res = await app.request(
      new Request("http://localhost/sepay", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
    expect(mAppend).toHaveBeenCalledTimes(1);
    expect(mAppend.mock.calls[0][1]).toMatchObject({
      entryType: "refund",
      amountMicros: "-1000000",
      currencyCode: "VND",
    });
    // balance debited by the negative refund amount
    expect(mApplyDelta).toHaveBeenCalledWith(expect.anything(), "tenant-1", "VND", -1000000n);
  });

  it("releases ALL active reservations for the tx (the release loop)", async () => {
    const app = buildApp();
    await app.request(new Request("http://localhost/sepay", { method: "POST", body: "{}" }));
    // Deleting the release loop in webhook-router makes these assertions fail.
    expect(mFindActive).toHaveBeenCalledTimes(1);
    expect(mMarkCompleted).toHaveBeenCalledTimes(2);
    expect(mMarkCompleted).toHaveBeenCalledWith(expect.anything(), "pending-1");
    expect(mMarkCompleted).toHaveBeenCalledWith(expect.anything(), "pending-2");
  });

  it("transitions the transaction status to 'refunded'", async () => {
    const app = buildApp();
    await app.request(new Request("http://localhost/sepay", { method: "POST", body: "{}" }));
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ROW.transactionId, "refunded");
  });

  it("does NOT debit the balance when the ledger entry is a duplicate (idempotent replay)", async () => {
    mAppend.mockResolvedValue({ inserted: false });
    const app = buildApp();
    await app.request(new Request("http://localhost/sepay", { method: "POST", body: "{}" }));
    expect(mApplyDelta).not.toHaveBeenCalled();
  });
});
