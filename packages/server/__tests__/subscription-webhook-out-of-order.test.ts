/**
 * A subscription invoice that arrives before its subscription.
 *
 * Stripe can deliver `invoice.paid` before the `customer.subscription.created`
 * that writes the subscription row. The pre-inbox handler answered that with a
 * 409 so the provider would redeliver — durability rested entirely on Stripe's
 * retry policy, and an invoice Stripe gave up on was lost with nothing to
 * replay from.
 *
 * Now the delivery goes through the durable inbox: it is recorded before any
 * business work, parked `unmatched` when its subscription is missing, and
 * retried by the same drain that retries payment webhooks. These tests pin
 * exactly that: the route always ACKs, the payload survives, the drain
 * dispatches the row to the subscription processor, and the credit lands once
 * the subscription exists — without a single provider redelivery.
 *
 * The inbox mock is stateful across requests because the property under test is
 * precisely what survives between deliveries.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inbox: [] as Array<Record<string, unknown>>,
  ledger: [] as Record<string, unknown>[],
  subscriptions: [] as Record<string, unknown>[],
}));

const CLAIMABLE = ["received", "unmatched", "failed"];

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js", () => ({
  recordDelivery: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    const existing = state.inbox.find(
      (r) => r.provider === input.provider && r.eventId === input.eventId,
    );
    if (existing) {
      return {
        row: existing,
        created: false,
        payloadMismatch: existing.payloadHash !== input.payloadHash,
      };
    }
    const row: Record<string, unknown> = {
      inboxId: crypto.randomUUID(),
      provider: input.provider,
      eventId: input.eventId,
      inboxKind: input.inboxKind ?? "payment",
      tenantId: null,
      matchedTransactionId: null,
      eventType: input.eventType,
      providerRef: input.providerRef ?? null,
      payloadHash: input.payloadHash,
      rawPayload: input.rawPayload ?? null,
      normalizedPayload: input.normalizedPayload ?? {},
      state: "received",
      processingAttempts: 0,
      nextRetryAt: new Date(0),
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      receivedAt: new Date(),
      processedAt: null,
      updatedAt: new Date(),
    };
    state.inbox.push(row);
    return { row, created: true, payloadMismatch: false };
  }),
  claimDeliveryById: vi.fn(async (_db: unknown, opts: { inboxId: string }) => {
    const row = state.inbox.find((r) => r.inboxId === opts.inboxId);
    if (!row || !CLAIMABLE.includes(row.state as string)) return undefined;
    row.state = "processing";
    row.processingAttempts = (row.processingAttempts as number) + 1;
    return { ...row };
  }),
  claimNextDelivery: vi.fn(async () => {
    const row = state.inbox.find((r) => CLAIMABLE.includes(r.state as string));
    if (!row) return undefined;
    row.state = "processing";
    row.processingAttempts = (row.processingAttempts as number) + 1;
    return { ...row };
  }),
  markSubscriptionDeliveryProcessed: vi.fn(
    async (
      _db: unknown,
      opts: { inboxId: string; matchedSubscriptionId?: string; tenantId?: string },
    ) => {
      const row = state.inbox.find((r) => r.inboxId === opts.inboxId);
      if (!row || row.state !== "processing") return undefined;
      row.state = "processed";
      row.matchedTransactionId = opts.matchedSubscriptionId ?? null;
      row.tenantId = opts.tenantId ?? null;
      row.processedAt = new Date();
      return { ...row };
    },
  ),
  markDeliveryProcessed: vi.fn(async () => undefined),
  markDeliveryUnmatched: vi.fn(async (_db: unknown, opts: { inboxId: string }) => {
    const row = state.inbox.find((r) => r.inboxId === opts.inboxId);
    if (!row || row.state !== "processing") return undefined;
    row.state = "unmatched";
    return { ...row };
  }),
  markDeliveryFailed: vi.fn(async (_db: unknown, opts: { inboxId: string }) => {
    const row = state.inbox.find((r) => r.inboxId === opts.inboxId);
    if (!row || row.state !== "processing") return undefined;
    row.state = "failed";
    return { ...row };
  }),
  markDeliveryDeadLettered: vi.fn(async (_db: unknown, opts: { inboxId: string }) => {
    const row = state.inbox.find((r) => r.inboxId === opts.inboxId);
    if (!row || row.state !== "processing") return undefined;
    row.state = "dead_letter";
    row.processedAt = new Date();
    return { ...row };
  }),
  requeueDeadLetteredDelivery: vi.fn(async () => undefined),
  findDeliveryById: vi.fn(async () => undefined),
  findDeliveryByEvent: vi.fn(async () => undefined),
  listDeliveriesByState: vi.fn(async () => []),
  sweepInboxPayloads: vi.fn(async () => 0),
  countDeliveriesByState: vi.fn(async () => 0),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/subscription.repo.js", () => ({
  findByProviderSub: vi.fn(async (_db: unknown, provider: string, id: string) =>
    state.subscriptions.find((r) => r.provider === provider && r.providerSubscriptionId === id),
  ),
  upsertFromEvent: vi.fn(async () => undefined),
  findById: vi.fn(),
  listForTenant: vi.fn(async () => []),
  listByCustomer: vi.fn(),
  listActiveByCustomer: vi.fn(async () => []),
  markCanceled: vi.fn(),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(
    async (
      _db: unknown,
      input: { provider: string; sourceId: string; entryType: string } & Record<string, unknown>,
    ) => {
      const existing = state.ledger.find(
        (r) =>
          r.provider === input.provider &&
          r.sourceId === input.sourceId &&
          r.entryType === input.entryType,
      );
      if (existing) return { row: existing, inserted: false };
      state.ledger.push(input);
      return { row: input, inserted: true };
    },
  ),
  listLedgerEntries: vi.fn(),
  computeBalancesByTenant: vi.fn(),
  sumRefundsByOriginalTransaction: vi.fn(async () => "0"),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/subscription-event.repo.js", () => ({
  appendSubscriptionEvent: vi.fn(async () => undefined),
  listEventsForSubscription: vi.fn(),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/customer.repo.js", () => ({
  clearProviderCustomerId: vi.fn(),
  findByProviderCustomerId: vi.fn(),
  deleteCustomerForCascade: vi.fn(async () => undefined),
}));

import { buildSubscriptionWebhookHandler } from "../src/routes/webhooks/subscription-webhook-handler.js";
import { processNextDelivery } from "../src/services/webhook-inbox-runner.js";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OWNER = "00000000-0000-0000-0000-000000000002";

function invoicePaid(eventId = "evt-inv-1") {
  return {
    eventId,
    type: "invoice.paid",
    subscriptionId: "sub_live_1",
    customerId: "cus_1",
    amountMicros: "9990000",
    currencyCode: "USD",
    invoiceId: "in_1",
    eventCreatedAt: new Date("2026-03-01T00:00:00Z"),
    metadata: {},
  };
}

function adapterFor(event: unknown) {
  return {
    id: "stripe-subscription",
    subscribe: vi.fn(),
    cancel: vi.fn(),
    upgrade: vi.fn(),
    listForCustomer: vi.fn(),
    getById: vi.fn(),
    verifyWebhookSignature: vi.fn(() => true),
    parseSubscriptionEvent: vi.fn(() => event),
    syncSubscription: vi.fn(),
  };
}

/** Propagates throws — a thrown business rule must reach the processor's catch. */
const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
};

function post(event: unknown) {
  const app = new Hono();
  app.route(
    "/webhooks",
    buildSubscriptionWebhookHandler({
      db: fakeDb as never,
      adapter: adapterFor(event) as never,
      logger: { warn: vi.fn() },
    }),
  );
  return app.request("http://localhost/webhooks/stripe-subscription", {
    method: "POST",
    body: "{}",
  });
}

function recordSubscription() {
  state.subscriptions.push({
    subscriptionId: "sub-row-1",
    tenantId: TENANT,
    ownerId: OWNER,
    provider: "stripe-subscription",
    providerSubscriptionId: "sub_live_1",
    status: "active",
    currencyCode: "USD",
    currentPeriodEnd: new Date("2026-04-01T00:00:00Z"),
    lastEventCreated: new Date("2026-02-01T00:00:00Z"),
  });
}

beforeEach(() => {
  state.inbox.length = 0;
  state.ledger.length = 0;
  state.subscriptions.length = 0;
});

describe("invoice.paid before its subscription exists", () => {
  it("ACKs and parks the delivery as durable, retryable work", async () => {
    const res = await post(invoicePaid());

    // The retry is owned by the inbox drain now, not by the provider's redelivery
    // policy — so the route ACKs instead of asking Stripe to try again.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ received: true, pending: "awaiting_subscription" });

    expect(state.inbox).toHaveLength(1);
    expect(state.inbox[0]).toMatchObject({
      state: "unmatched",
      inboxKind: "subscription",
      providerRef: "sub_live_1",
    });
    expect(state.ledger).toEqual([]);
  });

  it("the drain retries it and credits once the subscription is recorded", async () => {
    await post(invoicePaid());
    expect(state.ledger).toHaveLength(0);
    expect(state.inbox[0]?.state).toBe("unmatched");

    // Before the subscription lands, a drain tick parks it again — no dead end.
    await processNextDelivery({
      db: fakeDb as never,
      events: {},
      screeningConfigured: false,
      settlesExactAmount: () => true,
    });
    expect(state.inbox[0]?.state).toBe("unmatched");
    expect(state.ledger).toHaveLength(0);

    recordSubscription();

    // No provider redelivery: paykit's own drain resolves the parked work.
    const result = await processNextDelivery({
      db: fakeDb as never,
      events: {},
      screeningConfigured: false,
      settlesExactAmount: () => true,
    });

    expect(result).toMatchObject({ kind: "processed", matchedSubscriptionId: "sub-row-1" });
    expect(state.inbox[0]?.state).toBe("processed");
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      tenantId: TENANT,
      entryType: "subscription_credit",
      amountMicros: "9990000",
      sourceId: "in_1",
    });
  });

  it("credits on a provider redelivery too, once the subscription is recorded", async () => {
    await post(invoicePaid());
    expect(state.ledger).toHaveLength(0);

    recordSubscription();
    const res = await post(invoicePaid());

    expect(res.status).toBe(200);
    expect(state.ledger).toHaveLength(1);
    expect(state.inbox).toHaveLength(1); // redelivery reused the recorded row
    expect(state.inbox[0]?.state).toBe("processed");
  });

  it("still deduplicates a genuine replay after it was applied", async () => {
    recordSubscription();

    await post(invoicePaid());
    const replay = await post(invoicePaid());

    expect(replay.status).toBe(200);
    const body = (await replay.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ received: true, deferred: "already_processed" });
    expect(state.inbox).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });
});

describe("events that genuinely cannot be applied", () => {
  it("acks an invoice with no invoice id rather than retrying forever", async () => {
    // Nothing to key a ledger entry on, so no retry will ever help.
    const res = await post({ ...invoicePaid(), invoiceId: undefined });

    expect(res.status).toBe(200);
    expect(state.ledger).toEqual([]);
    // Recorded and closed, because it is genuinely finished.
    expect(state.inbox).toHaveLength(1);
    expect(state.inbox[0]?.state).toBe("processed");
  });

  it("acks a zero-amount invoice", async () => {
    recordSubscription();

    const res = await post({ ...invoicePaid(), amountMicros: "0" });

    expect(res.status).toBe(200);
    expect(state.ledger).toEqual([]);
    expect(state.inbox[0]?.state).toBe("processed");
  });
});
