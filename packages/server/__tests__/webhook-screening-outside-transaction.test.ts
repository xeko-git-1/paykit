/**
 * The transaction boundary this workstream exists to hold: the compliance
 * screening call must never run while the crediting transaction is open.
 *
 * That transaction holds a `SELECT ... FOR UPDATE` lock on the payment row plus a
 * pooled connection. Calling a tenant-supplied HTTP service from inside it means
 * one slow third party pins both for its full latency, every redelivery of the
 * same webhook queues behind the lock, and a pool of N connections is exhausted by
 * N concurrent payments. So the ordering is asserted directly rather than inferred
 * from where the call appears in the source: the test records when the transaction
 * closure exits and when the screening service is invoked, and requires the first
 * to happen before the second.
 *
 * The other half is durability. Parking the payment in `screening_pending` with an
 * enqueued job is what makes the split safe — if the process dies before the
 * verdict, the work is claimable rather than lost. A park that does not enqueue,
 * or an enqueue that does not park, would both leave a paid payment that no path
 * ever resolves.
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
  ScreeningService,
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
vi.mock("@vibecc/paykit-auth-core/db/repos/screening-job.repo.js", () => ({
  enqueueScreeningJob: vi.fn(),
  claimNextScreeningJob: vi.fn(),
  markScreeningDecided: vi.fn(),
  markScreeningRetryable: vi.fn(),
}));

import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { findActiveByTransaction } from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
import {
  claimNextScreeningJob,
  enqueueScreeningJob,
  markScreeningDecided,
} from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";

const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mFindActive = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;
const mEnqueue = enqueueScreeningJob as ReturnType<typeof vi.fn>;
const mClaim = claimNextScreeningJob as ReturnType<typeof vi.fn>;
const mDecided = markScreeningDecided as ReturnType<typeof vi.fn>;

const TX_ID = "a0000000-0000-4000-8000-000000000001";

/** Ordered log of the events whose relative order is the thing under test. */
let trace: string[];
let event: NormalizedWebhookEvent;
/** Statuses written through the guarded park UPDATE, in order. */
let parkedStatuses: unknown[];

function txRow() {
  return {
    transactionId: TX_ID,
    tenantId: "tenant-1",
    ownerId: "owner-1",
    provider: "sepay",
    amountMicros: "750000000",
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

function updateChain(rows: unknown[]) {
  return {
    set: (values: Record<string, unknown>) => {
      parkedStatuses.push(values.status);
      return { where: () => ({ returning: async () => rows }) };
    },
  };
}

/**
 * The transaction closure logs its own exit, which is the moment the row lock is
 * released. Anything logged after that ran with no lock held.
 */
function makeDb() {
  const tx = {
    select: () => chainable([txRow()]),
    update: () => updateChain([{ transactionId: TX_ID }]),
  };
  return {
    select: () => chainable([txRow()]),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      trace.push("tx:begin");
      const result = await fn(tx);
      trace.push("tx:commit");
      return result;
    },
  } as never;
}

function makeApp(extraDeps: Record<string, unknown>) {
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
  } as unknown as PaymentProviderAdapter;
  const registry = {
    get: (id: string) => (id === "sepay" ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
  return buildWebhookRouter({ db: makeDb(), registry, events: {}, ...extraDeps });
}

function post(extraDeps: Record<string, unknown>) {
  return makeApp(extraDeps).request(
    new Request("http://localhost/sepay", { method: "POST", body: "{}" }),
  );
}

function completedEvent(): NormalizedWebhookEvent {
  return {
    type: "payment.completed",
    eventId: "evt-1",
    providerRef: "prov-ref-1",
    amountMicros: "750000000",
    currencyCode: "VND",
    metadata: {},
  } as NormalizedWebhookEvent;
}

beforeEach(() => {
  trace = [];
  parkedStatuses = [];
  mAppend.mockReset().mockResolvedValue({ inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mFindActive.mockReset().mockResolvedValue([]);
  mUpdateStatus.mockReset().mockResolvedValue({ transactionId: TX_ID });
  mEnqueue.mockReset().mockImplementation(async () => {
    trace.push("enqueue");
    return { job: {}, enqueued: true };
  });
  // Nothing claimable by default, so the post-commit drain is a no-op unless a
  // test opts into a claimable job.
  mClaim.mockReset().mockResolvedValue(undefined);
  mDecided.mockReset().mockResolvedValue(undefined);
  event = completedEvent();
});

describe("screening runs outside the crediting transaction", () => {
  it("calls the screening service only after the transaction has committed", async () => {
    const screeningService: ScreeningService = async () => {
      trace.push("screening:call");
      return { verdict: "clear" };
    };
    // A claimable job is required for the drain to reach the service at all.
    mClaim.mockResolvedValue({
      jobId: "b0000000-0000-4000-8000-000000000009",
      transactionId: TX_ID,
      tenantId: "tenant-1",
      ownerId: "owner-1",
      provider: "sepay",
      sourceId: "prov-ref-1",
      creditMicros: "750000000",
      currencyCode: "VND",
      eventJson: {},
      state: "in_progress",
      attempts: 1,
    });

    const res = await post({ screeningService });
    expect(res.status).toBe(200);

    const commitAt = trace.indexOf("tx:commit");
    const screeningAt = trace.indexOf("screening:call");
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(screeningAt).toBeGreaterThanOrEqual(0);
    // The whole point: the lock is gone before the third party is asked.
    expect(screeningAt).toBeGreaterThan(commitAt);
  });

  it("enqueues the job inside the transaction, so the park and the job commit together", async () => {
    await post({ screeningService: async () => ({ verdict: "clear" }) });

    const beginAt = trace.indexOf("tx:begin");
    const enqueueAt = trace.indexOf("enqueue");
    const commitAt = trace.indexOf("tx:commit");
    expect(enqueueAt).toBeGreaterThan(beginAt);
    // Atomic with the park: a job that committed without the park (or vice versa)
    // would leave a payment nothing ever resolves.
    expect(enqueueAt).toBeLessThan(commitAt);
  });

  it("parks the payment in screening_pending instead of crediting it", async () => {
    await post({ screeningService: async () => ({ verdict: "clear" }) });

    expect(parkedStatuses).toContain("screening_pending");
    // No ledger write in the webhook transaction — the credit belongs to the
    // verdict transaction, after an answer exists.
    expect(mAppend).not.toHaveBeenCalled();
    expect(mApplyDelta).not.toHaveBeenCalled();
  });

  it("carries the settled amount and the ledger idempotency key on the job", async () => {
    await post({ screeningService: async () => ({ verdict: "clear" }) });

    expect(mEnqueue).toHaveBeenCalledTimes(1);
    const [, payload] = mEnqueue.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.transactionId).toBe(TX_ID);
    expect(payload.creditMicros).toBe("750000000");
    expect(payload.currencyCode).toBe("VND");
    // Same key the inline credit would have used, so a provider resend still
    // collapses onto one ledger row once the deferred credit lands.
    expect(payload.sourceId).toBe("prov-ref-1");
  });

  it("takes the same deferred path for a legacy onBeforeCredit hook", async () => {
    const hookCalls: string[] = [];
    await post({
      onBeforeCredit: async () => {
        hookCalls.push("hook");
        trace.push("screening:call");
      },
    });

    // The hook is adapted onto the screening contract rather than being called
    // inline, so the transaction boundary holds for existing integrations too.
    expect(parkedStatuses).toContain("screening_pending");
    expect(mEnqueue).toHaveBeenCalledTimes(1);
    if (trace.includes("screening:call")) {
      expect(trace.indexOf("screening:call")).toBeGreaterThan(trace.indexOf("tx:commit"));
    }
    expect(mAppend).not.toHaveBeenCalled();
  });

  it("credits inline, with no job, when no screening is configured", async () => {
    await post({});

    // Tenants that never configured screening keep the original path exactly:
    // one transaction, a ledger write inside it, no park and no queue.
    expect(mEnqueue).not.toHaveBeenCalled();
    expect(parkedStatuses).not.toContain("screening_pending");
    expect(mAppend).toHaveBeenCalledTimes(1);
    expect(mApplyDelta).toHaveBeenCalledTimes(1);
  });

  it("still ACKs 200 when the post-commit verdict attempt throws", async () => {
    mClaim.mockRejectedValue(new Error("claim failed"));

    const res = await post({ screeningService: async () => ({ verdict: "clear" }) });

    // The job row is the durable record, so a failed verdict attempt must not turn
    // into a non-2xx: that would make the provider redeliver an event already
    // recorded as processed. The verdict lands on a later attempt instead.
    expect(res.status).toBe(200);
    expect(parkedStatuses).toContain("screening_pending");
  });
});
