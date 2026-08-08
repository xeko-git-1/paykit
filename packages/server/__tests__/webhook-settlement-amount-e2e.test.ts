/**
 * Settlement-amount enforcement E2E — drives the REAL buildWebhookRouter so the
 * guard's wiring (not just its arithmetic) is pinned.
 *
 * The money-safety invariant under test: for a rail where the payer controls the
 * transferred amount, `completed` must mean paid-in-full. A short transfer
 * carrying a valid memo must leave the ledger untouched and the transaction
 * `pending`, and must NOT fire onPaymentCompleted — consumers ship goods on that
 * event.
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
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/balance.repo.js", () => ({ applyDelta: vi.fn() }));
vi.mock("@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => ({
  updateTransactionStatus: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/discount.repo.js", () => ({
  commitReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));

import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { findActiveByTransaction } from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";

const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mFindActive = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;

const TX_ID = "a0000000-0000-4000-8000-000000000001";
/** 500_000 VND requested, in the numeric(20,6) shape Postgres returns. */
const REQUESTED_MICROS = "500000000000.000000";

let event: NormalizedWebhookEvent;

function txRow() {
  return {
    transactionId: TX_ID,
    tenantId: "tenant-1",
    ownerId: "owner-1",
    provider: "sepay",
    amountMicros: REQUESTED_MICROS,
    currencyCode: "VND",
    status: "pending",
    providerRef: "prov-ref-1",
    metadataJson: {},
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
  const update = () => ({ set: () => ({ where: async () => undefined }) });
  return {
    select: () => chainable([{ ...txRow(), status: "completed" }]),
    update,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: () => chainable([txRow()]), update }),
  } as never;
}

function makeAdapter(settlesExactAmount: boolean | undefined): PaymentProviderAdapter {
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
    refund: async () => ({ state: "unsupported" }),
    fetchTransactions: async () => [],
  } as unknown as Record<string, unknown>;
  if (settlesExactAmount !== undefined) adapter.settlesExactAmount = settlesExactAmount;
  return adapter as unknown as PaymentProviderAdapter;
}

interface PostOptions {
  readonly settlesExactAmount?: boolean | undefined;
}

async function post(opts: PostOptions = {}) {
  const adapter = makeAdapter("settlesExactAmount" in opts ? opts.settlesExactAmount : false);
  const registry = {
    get: (id: string) => (id === "sepay" ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
  const completed = vi.fn();
  const metrics: { name: string; labels: Record<string, string> }[] = [];
  const app = buildWebhookRouter({
    db: makeDb(),
    registry,
    events: { onPaymentCompleted: completed },
    emitMetric: (name, labels) => {
      metrics.push({ name, labels });
    },
  });
  const res = await app.request(
    new Request("http://localhost/sepay", { method: "POST", body: "{}" }),
  );
  return { res, completed, metrics: metrics.map((m) => m.name) };
}

function completedEvent(receivedMicros: string): NormalizedWebhookEvent {
  return {
    type: "payment.completed",
    eventId: `evt-${receivedMicros}`,
    providerRef: "prov-ref-1",
    amountMicros: receivedMicros,
    currencyCode: "VND",
    metadata: {},
  } as NormalizedWebhookEvent;
}

beforeEach(() => {
  mAppend.mockReset().mockResolvedValue({ inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mFindActive.mockReset().mockResolvedValue([]);
  mUpdateStatus.mockReset().mockResolvedValue({ transactionId: TX_ID });
});

describe("webhook settlement amount enforcement", () => {
  it("does not credit or complete an underpaid transfer", async () => {
    event = completedEvent("10000000000"); // 10_000 VND against a 500_000 VND charge
    const { res, completed, metrics } = await post();

    expect(res.status).toBe(200); // acked so the provider stops retrying
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
    expect(mUpdateStatus).not.toHaveBeenCalled(); // status stays 'pending'
    expect(completed).not.toHaveBeenCalled(); // consumers must not ship goods
    expect(metrics).toContain("paykit_underpaid_received_total");
  });

  it("credits and completes an exact transfer", async () => {
    event = completedEvent("500000000000");
    const { res, completed } = await post();

    expect(res.status).toBe(200);
    expect(mAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entryType: "credit", amountMicros: "500000000000" }),
    );
    expect(mApplyDelta).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "VND",
      500_000_000_000n,
    );
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "completed");
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("credits only the requested amount when the payer overpays", async () => {
    event = completedEvent("600000000000"); // 600_000 VND against a 500_000 VND charge
    const { res, completed, metrics } = await post();

    expect(res.status).toBe(200);
    expect(mAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountMicros: "500000000000" }),
    );
    // The overage never reaches the balance — it is reconciled by hand.
    expect(mApplyDelta).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "VND",
      500_000_000_000n,
    );
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "completed");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(metrics).toContain("paykit_overpaid_total");
  });

  it("quarantines without crediting when the received amount is unreadable", async () => {
    event = completedEvent("12,000");
    const { res, completed, metrics } = await post();

    expect(res.status).toBe(200);
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "quarantine");
    expect(completed).not.toHaveBeenCalled();
    expect(metrics).toContain("paykit_amount_unreadable_total");
  });

  it("leaves exact-settling rails on their existing credit path", async () => {
    // A provider that owns the amount (card / redirect) is trusted even when the
    // webhook amount differs from the stored row — its own verified path decides.
    event = completedEvent("10000000000");
    const { res, completed } = await post({ settlesExactAmount: true });

    expect(res.status).toBe(200);
    expect(mAppend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountMicros: "10000000000" }),
    );
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "completed");
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("defaults an adapter that declares no settlement flag to the exact-settle path", async () => {
    // Absent flag must not silently start guarding pre-existing adapters.
    event = completedEvent("10000000000");
    const { completed } = await post({ settlesExactAmount: undefined });

    expect(mAppend).toHaveBeenCalled();
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("stays underpaid on webhook redelivery (never credits on retry)", async () => {
    event = completedEvent("10000000000");
    await post();
    await post();

    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
  });
});
