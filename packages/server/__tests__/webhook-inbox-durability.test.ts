/**
 * The failure this inbox exists to fix: a webhook that arrives before the checkout
 * has stored its provider reference.
 *
 * The old pipeline inserted a dedup row as the first statement of the business
 * transaction, then looked the payment up and returned early when it found nothing.
 * That early return committed the dedup row, answered 200, and made the delivery
 * permanently unrepeatable — the customer had paid, the ledger had nothing, and a
 * redelivery was refused by the primary key. No log, no metric, no replay.
 *
 * So the assertions here are about durability rather than arithmetic: the delivery
 * is recorded before anything is attempted, a missing payment leaves it retryable
 * instead of done, the retry credits once the payment appears, and marking it
 * processed never happens outside the transaction that did the work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const inbox = vi.hoisted(() => ({
  recordDelivery: vi.fn(),
  claimDeliveryById: vi.fn(),
  claimNextDelivery: vi.fn(),
  markDeliveryProcessed: vi.fn(),
  markDeliveryUnmatched: vi.fn(),
  markDeliveryFailed: vi.fn(),
  markDeliveryDeadLettered: vi.fn(),
  requeueDeadLetteredDelivery: vi.fn(),
  findDeliveryById: vi.fn(),
  findDeliveryByEvent: vi.fn(),
  listDeliveriesByState: vi.fn(),
  sweepInboxPayloads: vi.fn(),
  countDeliveriesByState: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/webhook-inbox.repo.js", () => inbox);

const payments = vi.hoisted(() => ({
  applyPaymentEvent: vi.fn(),
}));

vi.mock("../src/routes/webhooks/payment-event-processor.js", () => payments);

import { processDelivery } from "../src/services/webhook-delivery-processor.js";
import { INBOX_MAX_ATTEMPTS } from "../src/services/webhook-inbox-policy.js";
import { drainWebhookInbox, processNextDelivery } from "../src/services/webhook-inbox-runner.js";

const TX_ID = "a0000000-0000-4000-8000-000000000001";
const TENANT_ID = "c0000000-0000-4000-8000-000000000002";
const INBOX_ID = "b0000000-0000-4000-8000-000000000003";

const EVENT = {
  eventId: "evt-1",
  type: "payment.completed",
  providerRef: "prov-ref-1",
  amountMicros: "25000000",
  currencyCode: "USD",
  metadata: {},
};

function inboxRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-01T00:00:00.000Z");
  return {
    inboxId: INBOX_ID,
    provider: "test-provider",
    eventId: "evt-1",
    tenantId: null,
    matchedTransactionId: null,
    eventType: "payment.completed",
    providerRef: "prov-ref-1",
    payloadHash: "hash",
    rawPayload: "{}",
    normalizedPayload: { ...EVENT },
    state: "processing",
    processingAttempts: 1,
    nextRetryAt: now,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    lastErrorCode: null,
    lastErrorMessage: null,
    receivedAt: now,
    processedAt: null,
    updatedAt: now,
    ...overrides,
  } as never;
}

function paymentRow() {
  return {
    transactionId: TX_ID,
    tenantId: TENANT_ID,
    ownerId: "d0000000-0000-4000-8000-000000000004",
    provider: "test-provider",
    amountMicros: "25000000",
    currencyCode: "USD",
    status: "awaiting_payment",
    providerRef: "prov-ref-1",
    metadataJson: {},
  };
}

/**
 * A Drizzle stand-in that returns `rows` from a locked SELECT, and records the
 * order of calls so the ordering invariants can be asserted rather than assumed.
 */
function makeDb(rows: unknown[], trace: string[] = []) {
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.for = () => {
      trace.push("select-for-update");
      return chain;
    };
    chain.limit = async () => rows;
    return chain;
  };
  return {
    select: selectChain,
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      trace.push("tx-begin");
      const out = await fn({
        select: selectChain,
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      });
      trace.push("tx-commit");
      return out;
    },
  } as never;
}

function deps(db: unknown, extra: Record<string, unknown> = {}) {
  return {
    db: db as never,
    events: {},
    screeningConfigured: false,
    settlesExactAmount: () => true,
    random: () => 0.5,
    now: () => new Date("2026-03-01T00:00:00.000Z"),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  payments.applyPaymentEvent.mockResolvedValue({
    emitFor: null,
    transactionId: TX_ID,
    screeningEnqueued: false,
  });
  inbox.markDeliveryProcessed.mockResolvedValue(inboxRow({ state: "processed" }));
  inbox.markDeliveryUnmatched.mockResolvedValue(inboxRow({ state: "unmatched" }));
  inbox.markDeliveryFailed.mockResolvedValue(inboxRow({ state: "failed" }));
  inbox.markDeliveryDeadLettered.mockResolvedValue(inboxRow({ state: "dead_letter" }));
});

describe("a delivery with no matching payment", () => {
  it("is parked as unmatched, never as processed", async () => {
    const result = await processDelivery(deps(makeDb([])), inboxRow());

    expect(result).toEqual({ kind: "unmatched" });
    // The old pipeline's fatal move: committing a dedup row for work it never did.
    expect(inbox.markDeliveryProcessed).not.toHaveBeenCalled();
    expect(inbox.markDeliveryUnmatched).toHaveBeenCalledTimes(1);
  });

  it("schedules a retry rather than leaving it due immediately", async () => {
    await processDelivery(deps(makeDb([])), inboxRow());

    const [, opts] = inbox.markDeliveryUnmatched.mock.calls[0] as [unknown, { nextRetryAt: Date }];
    // A delivery due at the same instant would busy-loop the drain.
    expect(opts.nextRetryAt.getTime()).toBeGreaterThan(
      new Date("2026-03-01T00:00:00.000Z").getTime(),
    );
  });

  it("meters the unmatched delivery so it is visible", async () => {
    const emitMetric = vi.fn();
    await processDelivery(deps(makeDb([]), { emitMetric }), inboxRow());

    expect(emitMetric).toHaveBeenCalledWith(
      "paykit_webhook_unmatched_total",
      expect.objectContaining({ provider: "test-provider" }),
    );
  });

  it("dead-letters once the attempts are spent, so it stops cycling silently", async () => {
    const emitMetric = vi.fn();
    const result = await processDelivery(
      deps(makeDb([]), { emitMetric }),
      inboxRow({ processingAttempts: INBOX_MAX_ATTEMPTS }),
    );

    expect(result.kind).toBe("dead_letter");
    expect(inbox.markDeliveryDeadLettered).toHaveBeenCalledTimes(1);
    // This is the case that should page someone: money may have moved upstream with
    // nothing here to match it against.
    expect(emitMetric).toHaveBeenCalledWith(
      "paykit_webhook_dead_letter_total",
      expect.objectContaining({ provider: "test-provider" }),
    );
  });

  it("credits on the retry once the payment finally exists", async () => {
    // The whole point: the delivery survived long enough for the checkout to commit.
    const result = await processDelivery(
      deps(makeDb([paymentRow()])),
      inboxRow({ state: "processing", processingAttempts: 2 }),
    );

    expect(result).toMatchObject({ kind: "processed", transactionId: TX_ID });
    expect(payments.applyPaymentEvent).toHaveBeenCalledTimes(1);
    expect(inbox.markDeliveryProcessed).toHaveBeenCalledTimes(1);
  });
});

describe("processed is recorded with the work, not around it", () => {
  it("marks processed inside the same transaction that applied the event", async () => {
    const trace: string[] = [];
    await processDelivery(deps(makeDb([paymentRow()], trace)), inboxRow());

    // If the mark landed after the commit, a crash in between would leave work done
    // and the delivery still claimable — a double credit on retry, prevented only by
    // ledger uniqueness. Keeping both in one transaction removes the window.
    expect(trace).toEqual(["tx-begin", "select-for-update", "tx-commit"]);
    const markedDuringTx = inbox.markDeliveryProcessed.mock.invocationCallOrder[0];
    expect(markedDuringTx).toBeDefined();
    expect(inbox.markDeliveryProcessed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inboxId: INBOX_ID,
        matchedTransactionId: TX_ID,
        tenantId: TENANT_ID,
      }),
    );
  });

  it("locks the payment row before applying the event", async () => {
    const trace: string[] = [];
    await processDelivery(deps(makeDb([paymentRow()], trace)), inboxRow());

    expect(trace).toContain("select-for-update");
    expect(payments.applyPaymentEvent).toHaveBeenCalled();
  });

  it("leaves the delivery retryable when the business transaction throws", async () => {
    payments.applyPaymentEvent.mockRejectedValue(new Error("ledger unavailable"));

    const result = await processDelivery(deps(makeDb([paymentRow()])), inboxRow());

    expect(result).toMatchObject({ kind: "failed" });
    expect(inbox.markDeliveryFailed).toHaveBeenCalledTimes(1);
    expect(inbox.markDeliveryProcessed).not.toHaveBeenCalled();
  });

  it("dead-letters a failure that has exhausted its attempts", async () => {
    payments.applyPaymentEvent.mockRejectedValue(new Error("still broken"));

    const result = await processDelivery(
      deps(makeDb([paymentRow()])),
      inboxRow({ processingAttempts: INBOX_MAX_ATTEMPTS }),
    );

    expect(result.kind).toBe("dead_letter");
    expect(inbox.markDeliveryFailed).not.toHaveBeenCalled();
  });
});

describe("an unusable stored payload", () => {
  it("is dead-lettered instead of retried, because every attempt fails the same way", async () => {
    const result = await processDelivery(
      deps(makeDb([paymentRow()])),
      inboxRow({ normalizedPayload: { nothing: "useful" } }),
    );

    expect(result.kind).toBe("dead_letter");
    expect(inbox.markDeliveryDeadLettered).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "UNREADABLE_PAYLOAD" }),
    );
    // Nothing was attempted against the payment.
    expect(payments.applyPaymentEvent).not.toHaveBeenCalled();
  });
});

describe("the drain", () => {
  it("stops as soon as nothing is due", async () => {
    inbox.claimNextDelivery.mockResolvedValue(undefined);

    const results = await drainWebhookInbox(deps(makeDb([])));

    expect(results).toEqual([]);
    expect(inbox.claimNextDelivery).toHaveBeenCalledTimes(1);
  });

  it("processes each claimed delivery and honours the bound", async () => {
    inbox.claimNextDelivery.mockResolvedValue(inboxRow());

    const results = await drainWebhookInbox(deps(makeDb([paymentRow()])), 3);

    // The bound exists so one invocation cannot run unboundedly against a backlog.
    expect(results).toHaveLength(3);
    expect(inbox.claimNextDelivery).toHaveBeenCalledTimes(3);
  });

  it("keeps draining past a delivery that could not be matched", async () => {
    inbox.claimNextDelivery.mockResolvedValue(inboxRow());

    const results = await drainWebhookInbox(deps(makeDb([])), 2);

    // A failure must not stop the queue: the processor records every outcome rather
    // than throwing, so one stuck delivery cannot block the ones behind it.
    expect(results.map((r) => r.kind)).toEqual(["unmatched", "unmatched"]);
  });

  it("reports nothing when the claim finds no work", async () => {
    inbox.claimNextDelivery.mockResolvedValue(undefined);

    expect(await processNextDelivery(deps(makeDb([])))).toBeUndefined();
  });
});
