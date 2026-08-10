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
 *
 * One case deliberately does NOT resolve the reservation here: when compliance
 * screening is configured, the payment is parked rather than decided, so the
 * promo slot has to stay held until a verdict exists. Releasing it at park time
 * would free the slot for a payment that may still be credited. The verdict
 * transaction owns that decision — see screening-verdict-reservation.test.ts.
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
} from "@xeko-git-1/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The router records every delivery in the inbox before processing it, so this
// stands in for that repo. The factory is async so the shared helper can be pulled
// in from inside it — a hoisted factory cannot reach a top-level import.
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js", async () => {
  const { inboxRepoMock } = await import("./helpers/webhook-inbox-repo-mock.js");
  return inboxRepoMock();
});
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js", () => ({ applyDelta: vi.fn() }));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js", () => ({
  updateTransactionStatus: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/discount.repo.js", () => ({
  commitReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));
// Screening turns payment.completed into a park + enqueue. Claiming returns
// nothing so the post-commit drain is a no-op: this file is about the
// reservation, and the verdict path has its own tests.
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/screening-job.repo.js", () => ({
  enqueueScreeningJob: vi.fn(),
  claimNextScreeningJob: vi.fn(),
  markScreeningDecided: vi.fn(),
  markScreeningRetryable: vi.fn(),
}));

import { applyDelta } from "@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js";
import {
  commitReservation,
  releaseReservation,
} from "@xeko-git-1/paykit-auth-core/db/repos/discount.repo.js";
import { appendLedgerEntryIdempotent } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js";
import { findActiveByTransaction } from "@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js";
import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";

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

/** Drizzle update chain, used by the screening park (UPDATE ... RETURNING). */
function updateChain(returned: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = () => chain;
  chain.where = () => chain;
  chain.returning = async () => returned;
  return chain;
}

function makeDb() {
  const tx = {
    select: () => chainable([txRow()]),
    update: () => updateChain([{ transactionId: txRow().transactionId }]),
  };
  return {
    select: () => chainable([txRow()]),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
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
  mAppend.mockReset().mockResolvedValue({ inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mFindActive.mockReset().mockResolvedValue([]);
  mUpdateStatus
    .mockReset()
    .mockResolvedValue({ transactionId: "a0000000-0000-4000-8000-000000000001" });
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

  it("holds the reservation when the payment is parked for screening", async () => {
    event = {
      type: "payment.completed",
      eventId: "evt-q-1",
      providerRef: "prov-ref-1",
      amountMicros: "750000000",
      currencyCode: "VND",
      metadata: {},
    } as NormalizedWebhookEvent;
    const res = await post({
      onBeforeCredit: async () => {
        throw new Error("sanctioned");
      },
    });
    expect(res.status).toBe(200);
    // The webhook no longer knows the outcome: the screening call happens after
    // this transaction commits. Neither resolving the slot is correct yet —
    // committing would consume it for a payment that may be rejected, releasing
    // would free it for one that may still be credited.
    expect(mCommit).not.toHaveBeenCalled();
    expect(mRelease).not.toHaveBeenCalled();
    // And the payment was parked, not credited.
    expect(mAppend).not.toHaveBeenCalled();
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
