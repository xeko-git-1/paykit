/**
 * A subscription invoice that arrives before its subscription.
 *
 * The dedup row is the first statement of the handler's transaction, so a plain
 * `return` from inside it still commits: the event is permanently marked seen, the
 * route answers 200, the provider stops retrying, and a redelivery is refused by the
 * primary key. `invoice.paid` used to take that path whenever its subscription row
 * was not written yet — and Stripe can deliver an invoice before the subscription
 * event that creates it. A customer paid, no credit was written, and nothing could
 * replay it.
 *
 * These tests use a transaction stand-in that actually rolls back, because the
 * property under test is exactly that: whether the dedup row survives. A fake `tx`
 * that ignores throws would pass either way.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** Committed dedup rows. Cleared on rollback, like the real table. */
  dedup: [] as { provider: string; eventId: string }[],
  /** Rows written inside the open transaction, not yet committed. */
  pending: [] as { provider: string; eventId: string }[],
  ledger: [] as Record<string, unknown>[],
  subscriptions: [] as Record<string, unknown>[],
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js", () => ({
  tryRecordWebhookEvent: vi.fn(async (_db: unknown, provider: string, eventId: string) => {
    const seen = [...state.dedup, ...state.pending].some(
      (r) => r.provider === provider && r.eventId === eventId,
    );
    if (seen) return { recorded: false };
    state.pending.push({ provider, eventId });
    return { recorded: true };
  }),
  listEvents: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/subscription.repo.js", () => ({
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

vi.mock("@vibecc/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    state.ledger.push(input);
    return { row: input, inserted: true };
  }),
  listLedgerEntries: vi.fn(),
  computeBalancesByTenant: vi.fn(),
  sumRefundsByOriginalTransaction: vi.fn(async () => "0"),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/subscription-event.repo.js", () => ({
  appendSubscriptionEvent: vi.fn(async () => undefined),
  listEventsForSubscription: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/customer.repo.js", () => ({
  clearProviderCustomerId: vi.fn(),
  findByProviderCustomerId: vi.fn(),
}));

import { buildSubscriptionWebhookHandler } from "../src/routes/webhooks/subscription-webhook-handler.js";

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

/** Commits on return, discards on throw — the behaviour the invariant rests on. */
function rollbackAwareDb() {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      state.pending.length = 0;
      try {
        const out = await fn({});
        state.dedup.push(...state.pending);
        return out;
      } finally {
        state.pending.length = 0;
      }
    },
  };
}

function post(event: unknown) {
  const app = new Hono();
  app.route(
    "/webhooks",
    buildSubscriptionWebhookHandler({
      db: rollbackAwareDb() as never,
      adapter: adapterFor(event) as never,
      logger: { warn: vi.fn() },
    }),
  );
  return app.request("http://localhost/webhooks/stripe-subscription", {
    method: "POST",
    body: "{}",
  });
}

beforeEach(() => {
  state.dedup.length = 0;
  state.pending.length = 0;
  state.ledger.length = 0;
  state.subscriptions.length = 0;
});

describe("invoice.paid before its subscription exists", () => {
  it("does not answer 200, so the provider keeps retrying", async () => {
    const res = await post(invoicePaid());

    // A 200 here is what told Stripe to stop, on an event that credited nothing.
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WEBHOOK_NOT_YET_APPLICABLE");
  });

  it("leaves no dedup row behind, so a redelivery is not refused", async () => {
    await post(invoicePaid());

    // The whole failure hinged on this row surviving a return that did no work.
    expect(state.dedup).toEqual([]);
    expect(state.ledger).toEqual([]);
  });

  it("credits on the redelivery once the subscription is recorded", async () => {
    await post(invoicePaid());
    expect(state.ledger).toHaveLength(0);

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

    const res = await post(invoicePaid());

    expect(res.status).toBe(200);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      tenantId: TENANT,
      entryType: "subscription_credit",
      amountMicros: "9990000",
      sourceId: "in_1",
    });
  });

  it("still deduplicates a genuine replay after it was applied", async () => {
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

    await post(invoicePaid());
    await post(invoicePaid());

    // Making the unmatched case retryable must not have weakened dedup for the
    // case that WAS handled.
    expect(state.dedup).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });
});

describe("events that genuinely cannot be applied", () => {
  it("acks an invoice with no invoice id rather than retrying forever", async () => {
    // Nothing to key a ledger entry on, so no redelivery will ever help.
    const res = await post({ ...invoicePaid(), invoiceId: undefined });

    expect(res.status).toBe(200);
    expect(state.ledger).toEqual([]);
    // Recorded as seen, because it is genuinely finished.
    expect(state.dedup).toHaveLength(1);
  });

  it("acks a zero-amount invoice", async () => {
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

    const res = await post({ ...invoicePaid(), amountMicros: "0" });

    expect(res.status).toBe(200);
    expect(state.ledger).toEqual([]);
  });
});
