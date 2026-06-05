/**
 * Webhook discount-reservation lifecycle E2E — drives the REAL webhook router
 * and asserts the reserve→commit/release lifecycle:
 *   - payment.completed with metadataJson.discountId → commitReservation
 *   - payment.failed / payment.expired with discountId → releaseReservation
 *   - no discountId (embedded BYO-resolver checkout) → neither is called
 *
 * The reservation move happens inside the webhook transaction, keyed only on
 * the tx row's metadata, so it stays dormant for any checkout that did not
 * reserve a paykit.discounts code.
 */
import type { NormalizedWebhookEvent, PaymentProviderAdapter, ProviderRegistry } from "@vibecc/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js", () => ({ tryRecordWebhookEvent: vi.fn() }));
vi.mock("@vibecc/paykit-auth-core/db/repos/ledger.repo.js", () => ({ appendLedgerEntryIdempotent: vi.fn() }));
vi.mock("@vibecc/paykit-auth-core/db/repos/balance.repo.js", () => ({ applyDelta: vi.fn() }));
vi.mock("@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => ({ updateTransactionStatus: vi.fn() }));
vi.mock("@vibecc/paykit-auth-core/db/repos/discount.repo.js", () => ({
  commitReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));

import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";
import { tryRecordWebhookEvent } from "@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import { findActiveByTransaction } from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { commitReservation, releaseReservation } from "@vibecc/paykit-auth-core/db/repos/discount.repo.js";

const mTryRecord = tryRecordWebhookEvent as ReturnType<typeof vi.fn>;
const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mFindActive = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;
const mCommit = commitReservation as ReturnType<typeof vi.fn>;
const mRelease = releaseReservation as ReturnType<typeof vi.fn>;

let event: NormalizedWebhookEvent;
let txMetadata: Record<string, unknown>;

function txRow() {
  return {
    transactionId: "a0000000-0000-4000-8000-000000000001",
    tenantId: "tenant-1",
    ownerId: "owner-1",
    provider: "sepay",
    amountMicros: "750000000",
    currencyCode: "VND",
    status: "pending",
    providerRef: "prov-ref-1",
    metadataJson: txMetadata,
  };
}

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
    select: () => chainable([txRow()]),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: () => chainable([txRow()]) }),
  } as never;
}

function makeApp(extraDeps: Record<string, unknown> = {}) {
  const adapter: PaymentProviderAdapter = {
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
    get: (id: string) => (id === "sepay" ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
  return buildWebhookRouter({ db: makeDb(), registry, events: {}, ...extraDeps });
}

function post(extraDeps: Record<string, unknown> = {}) {
  return makeApp(extraDeps).request(
    new Request("http://localhost/sepay", { method: "POST", body: "{}" }),
  );
}

beforeEach(() => {
  mTryRecord.mockReset().mockResolvedValue({ recorded: true });
  mAppend.mockReset().mockResolvedValue({ inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mFindActive.mockReset().mockResolvedValue([]);
  mUpdateStatus.mockReset().mockResolvedValue({ transactionId: "a0000000-0000-4000-8000-000000000001" });
  mCommit.mockReset().mockResolvedValue(true);
  mRelease.mockReset().mockResolvedValue(true);
  txMetadata = { discountId: "disc-1", discountApplied: true };
});

describe("webhook discount reservation lifecycle", () => {
  it("commits the reservation on payment.completed when a discountId is present", async () => {
    event = {
      type: "payment.completed",
      eventId: "evt-c-1",
      providerRef: "prov-ref-1",
      amountMicros: "750000000",
      currencyCode: "VND",
      metadata: {},
    } as NormalizedWebhookEvent;
    const res = await post();
    expect(res.status).toBe(200);
    expect(mCommit).toHaveBeenCalledWith(expect.anything(), "disc-1");
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("releases the reservation on payment.failed", async () => {
    event = {
      type: "payment.failed",
      eventId: "evt-f-1",
      providerRef: "prov-ref-1",
      metadata: {},
    } as NormalizedWebhookEvent;
    await post();
    expect(mRelease).toHaveBeenCalledWith(expect.anything(), "disc-1");
    expect(mCommit).not.toHaveBeenCalled();
  });

  it("releases the reservation on payment.expired", async () => {
    event = {
      type: "payment.expired",
      eventId: "evt-e-1",
      providerRef: "prov-ref-1",
      metadata: {},
    } as NormalizedWebhookEvent;
    await post();
    expect(mRelease).toHaveBeenCalledWith(expect.anything(), "disc-1");
  });

  it("does nothing to reservations when the tx has no discountId (embedded mode)", async () => {
    txMetadata = {}; // no discountId
    event = {
      type: "payment.completed",
      eventId: "evt-c-2",
      providerRef: "prov-ref-1",
      amountMicros: "750000000",
      currencyCode: "VND",
      metadata: {},
    } as NormalizedWebhookEvent;
    await post();
    expect(mCommit).not.toHaveBeenCalled();
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("releases the reservation when onBeforeCredit quarantines the payment", async () => {
    event = {
      type: "payment.completed",
      eventId: "evt-q-1",
      providerRef: "prov-ref-1",
      amountMicros: "750000000",
      currencyCode: "VND",
      metadata: {},
    } as NormalizedWebhookEvent;
    await post({
      onBeforeCredit: async () => {
        throw new Error("sanctioned");
      },
    });
    // Quarantined → never completes → reservation freed, not committed.
    expect(mRelease).toHaveBeenCalledWith(expect.anything(), "disc-1");
    expect(mCommit).not.toHaveBeenCalled();
  });

  it("releases the reservation on payment.amount_mismatch (quarantine)", async () => {
    event = {
      type: "payment.amount_mismatch",
      eventId: "evt-q-2",
      providerRef: "prov-ref-1",
      amountMicros: "740000000",
      expectedAmountMicros: "750000000",
      currencyCode: "VND",
      metadata: {},
    } as NormalizedWebhookEvent;
    await post();
    expect(mRelease).toHaveBeenCalledWith(expect.anything(), "disc-1");
    expect(mCommit).not.toHaveBeenCalled();
  });
});
