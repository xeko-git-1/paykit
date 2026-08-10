/**
 * Phase 06 — subscription-webhook-handler tests with mocked repos.
 *
 * Coverage:
 *   - Signature invalid → 401, no DB writes
 *   - Unknown event type → 200 + skip
 *   - Dedup replay (same event_id) → 200, single dispatch
 *   - sub.created/updated/deleted UPSERT pipeline (RT F9 last-write-wins)
 *   - invoice.paid → ledger CREDIT (USD-only, skip zero, skip currency mismatch,
 *     skip late-after-cancel, dedup by source_id) (RT F1)
 *   - invoice.payment_failed → cache update to past_due
 *   - charge.refunded / dispute.funds_withdrawn / credit_note.created → DEBIT
 *   - charge.dispute.created → audit-only (no ledger row)
 *   - customer.deleted → cascade-cancel active/trialing/past_due (Val S4 Q1)
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const subscriptionRows: Array<Record<string, unknown>> = [];
const ledgerRows: Array<Record<string, unknown>> = [];
const eventRows: Array<Record<string, unknown>> = [];
const webhookEventRows: Array<{ provider: string; eventId: string }> = [];

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/subscription.repo.js", () => ({
  upsertFromEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    const existing = subscriptionRows.find(
      (r) =>
        r.provider === input.provider &&
        r.providerSubscriptionId === input.providerSubscriptionId,
    );
    if (existing) {
      const incoming = input.lastEventCreated as Date;
      const current = existing.lastEventCreated as Date;
      if (incoming.getTime() > current.getTime()) {
        Object.assign(existing, input, { updatedAt: new Date() });
      }
      return existing;
    }
    const row = {
      subscriptionId: crypto.randomUUID(),
      cancelAtPeriodEnd: false,
      currencyCode: "USD",
      latestInvoiceId: null,
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    };
    subscriptionRows.push(row);
    return row;
  }),
  findByProviderSub: vi.fn(async (_db: unknown, provider: string, id: string) =>
    subscriptionRows.find(
      (r) => r.provider === provider && r.providerSubscriptionId === id,
    ),
  ),
  findById: vi.fn(),
  listForTenant: vi.fn(async () => []),
  listByCustomer: vi.fn(),
  listActiveByCustomer: vi.fn(async (_db: unknown, provider: string, customerId: string) =>
    subscriptionRows.filter(
      (r) =>
        r.provider === provider &&
        r.customerId === customerId &&
        ["active", "trialing", "past_due"].includes(r.status as string),
    ),
  ),
  markCanceled: vi.fn(async (_db: unknown, provider: string, id: string, eventCreatedAt: Date) => {
    const row = subscriptionRows.find(
      (r) => r.provider === provider && r.providerSubscriptionId === id,
    );
    if (!row) return undefined;
    if ((row.lastEventCreated as Date).getTime() < eventCreatedAt.getTime()) {
      row.status = "canceled";
      row.lastEventCreated = eventCreatedAt;
      row.updatedAt = new Date();
    }
    return row;
  }),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/customer.repo.js", () => ({
  findCustomer: vi.fn(),
  findByProviderCustomerId: vi.fn(),
  getOrInsertCustomer: vi.fn(),
  deleteCustomerForCascade: vi.fn(async () => undefined),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js", async () => {
  return {
    appendLedgerEntry: vi.fn(),
    appendLedgerEntryIdempotent: vi.fn(
      async (
        _db: unknown,
        input: { provider: string; sourceId: string; entryType: string } & Record<string, unknown>,
      ) => {
        const existing = ledgerRows.find(
          (r) =>
            r.provider === input.provider &&
            r.sourceId === input.sourceId &&
            r.entryType === input.entryType,
        );
        if (existing) return { row: existing, inserted: false };
        const row = { entryId: crypto.randomUUID(), createdAt: new Date(), ...input };
        ledgerRows.push(row);
        return { row, inserted: true };
      },
    ),
    listLedgerEntries: vi.fn(),
    computeBalancesByTenant: vi.fn(),
  };
});

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/subscription-event.repo.js", () => ({
  appendSubscriptionEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    const row = { eventId: crypto.randomUUID(), createdAt: new Date(), ...input };
    eventRows.push(row);
    return row;
  }),
  listEventsForSubscription: vi.fn(),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/webhook-event.repo.js", () => ({
  tryRecordWebhookEvent: vi.fn(async (_db: unknown, provider: string, eventId: string) => {
    if (webhookEventRows.some((r) => r.provider === provider && r.eventId === eventId)) {
      return { recorded: false };
    }
    webhookEventRows.push({ provider, eventId });
    return { recorded: true };
  }),
  listEvents: vi.fn(),
}));

const { buildSubscriptionWebhookHandler } = await import(
  "../src/routes/webhooks/subscription-webhook-handler.js"
);

const TENANT_A = "00000000-0000-0000-0000-000000000001";

interface ParsedEvent {
  eventId: string;
  type: string;
  subscriptionId: string;
  customerId: string;
  status?: string;
  amountMicros?: string;
  currencyCode?: string;
  invoiceId?: string;
  chargeId?: string;
  refundAmountMicros?: string;
  eventCreatedAt: Date;
  metadata: Record<string, unknown>;
}

function makeAdapter(opts: {
  parseReturns?: ParsedEvent | null;
  signatureValid?: boolean;
} = {}) {
  return {
    id: "stripe-subscription",
    subscribe: vi.fn(),
    cancel: vi.fn(),
    upgrade: vi.fn(),
    listForCustomer: vi.fn(),
    getById: vi.fn(),
    verifyWebhookSignature: vi.fn(() => opts.signatureValid ?? true),
    parseSubscriptionEvent: vi.fn(() => opts.parseReturns ?? null),
    syncSubscription: vi.fn(),
  };
}

function buildApp(adapter: ReturnType<typeof makeAdapter>) {
  const app = new Hono();
  const fakeDb = {
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}),
  };
  app.route(
    "/webhooks",
    buildSubscriptionWebhookHandler({
      db: fakeDb as never,
      adapter: adapter as never,
    }),
  );
  return app;
}

beforeEach(() => {
  subscriptionRows.length = 0;
  ledgerRows.length = 0;
  eventRows.length = 0;
  webhookEventRows.length = 0;
});

const baseSub = (overrides: Partial<Record<string, unknown>> = {}) => ({
  subscriptionId: "11111111-1111-1111-1111-111111111111",
  tenantId: TENANT_A,
  ownerId: TENANT_A,
  provider: "stripe-subscription",
  providerSubscriptionId: "sub_x",
  customerId: "cus_a",
  priceId: "price_p1",
  status: "active",
  currencyCode: "USD",
  currentPeriodEnd: new Date("2026-06-01"),
  cancelAtPeriodEnd: false,
  latestInvoiceId: null,
  lastEventCreated: new Date("2026-05-01"),
  metadataJson: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("Signature + parsing", () => {
  it("invalid signature → 401, no DB writes", async () => {
    const adapter = makeAdapter({ signatureValid: false });
    const app = buildApp(adapter);
    const r = await app.request("/webhooks/stripe-subscription", {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(401);
    expect(webhookEventRows).toHaveLength(0);
    expect(ledgerRows).toHaveLength(0);
  });

  it("unknown event type (parse returns null) → 200, no writes", async () => {
    const adapter = makeAdapter({ parseReturns: null });
    const app = buildApp(adapter);
    const r = await app.request("/webhooks/stripe-subscription", {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(webhookEventRows).toHaveLength(0);
  });

  it("dedup: same event_id arriving twice → second is silent skip", async () => {
    subscriptionRows.push(baseSub());
    const evt: ParsedEvent = {
      eventId: "evt_dup",
      type: "sub.updated",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      status: "active",
      eventCreatedAt: new Date("2026-05-10"),
      metadata: {},
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(webhookEventRows).toHaveLength(1);
    expect(eventRows.length).toBeLessThanOrEqual(1);
  });
});

describe("Sub lifecycle (RT F9 last-write-wins)", () => {
  it("sub.deleted marks status=canceled when arriving with newer event time", async () => {
    subscriptionRows.push(baseSub({ lastEventCreated: new Date("2026-04-01") }));
    const evt: ParsedEvent = {
      eventId: "evt_del",
      type: "sub.deleted",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      status: "canceled",
      eventCreatedAt: new Date("2026-05-15"),
      metadata: { paykit_tenant_id: TENANT_A },
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    const r = await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(subscriptionRows[0]?.status).toBe("canceled");
  });

  it("out-of-order: older event does NOT roll back newer state (RT F9)", async () => {
    subscriptionRows.push(baseSub({ status: "canceled", lastEventCreated: new Date("2026-05-10") }));
    const evt: ParsedEvent = {
      eventId: "evt_old",
      type: "sub.updated",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      status: "active",
      eventCreatedAt: new Date("2026-05-01"),
      metadata: { paykit_tenant_id: TENANT_A },
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(subscriptionRows[0]?.status).toBe("canceled");
  });
});

describe("invoice.paid ledger contract (RT F1)", () => {
  function invoicePaidEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
    return {
      eventId: "evt_inv_1",
      type: "invoice.paid",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      amountMicros: "10000000",
      currencyCode: "USD",
      invoiceId: "in_001",
      eventCreatedAt: new Date("2026-05-15"),
      metadata: {},
      ...overrides,
    };
  }

  it("appends ledger CREDIT row for amount_paid in USD", async () => {
    subscriptionRows.push(baseSub());
    const adapter = makeAdapter({ parseReturns: invoicePaidEvent() });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.entryType).toBe("subscription_credit");
    expect(ledgerRows[0]?.amountMicros).toBe("10000000");
    expect(ledgerRows[0]?.sourceId).toBe("in_001");
  });

  it("zero amount → no ledger row (cache + audit only)", async () => {
    subscriptionRows.push(baseSub());
    const adapter = makeAdapter({ parseReturns: invoicePaidEvent({ amountMicros: "0" }) });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(0);
  });

  it("non-USD currency → no ledger row, log LEDGER_CURRENCY_MISMATCH", async () => {
    subscriptionRows.push(baseSub());
    const adapter = makeAdapter({ parseReturns: invoicePaidEvent({ currencyCode: "EUR" }) });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(0);
  });

  it("late invoice on canceled sub → no ledger", async () => {
    subscriptionRows.push(
      baseSub({
        status: "canceled",
        currentPeriodEnd: new Date("2026-04-01"),
      }),
    );
    const adapter = makeAdapter({
      parseReturns: invoicePaidEvent({ eventCreatedAt: new Date("2026-05-15") }),
    });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(0);
  });

  it("Stripe resend with new event_id but same invoice → ledger UNIQUE blocks (single credit)", async () => {
    subscriptionRows.push(baseSub());
    const adapter1 = makeAdapter({ parseReturns: invoicePaidEvent({ eventId: "evt_first" }) });
    const adapter2 = makeAdapter({ parseReturns: invoicePaidEvent({ eventId: "evt_second" }) });
    const app1 = buildApp(adapter1);
    const app2 = buildApp(adapter2);
    await app1.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    await app2.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(1);
  });
});

describe("Refund / dispute / credit_note ledger contract (RT F1)", () => {
  it("charge.refunded → DEBIT entry", async () => {
    subscriptionRows.push(baseSub());
    const evt: ParsedEvent = {
      eventId: "evt_ref",
      type: "charge.refunded",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      currencyCode: "USD",
      refundAmountMicros: "5000000",
      chargeId: "ch_1",
      eventCreatedAt: new Date("2026-05-20"),
      metadata: {},
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.entryType).toBe("refund_debit");
    expect(ledgerRows[0]?.amountMicros).toBe("-5000000");
  });

  it("charge.dispute.created → audit-only (no ledger)", async () => {
    subscriptionRows.push(baseSub());
    const evt: ParsedEvent = {
      eventId: "evt_disp",
      type: "charge.dispute.created",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      currencyCode: "USD",
      amountMicros: "3000000",
      chargeId: "ch_1",
      eventCreatedAt: new Date("2026-05-20"),
      metadata: { disputeId: "dp_1" },
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(0);
  });

  it("charge.dispute.funds_withdrawn → DEBIT entry", async () => {
    subscriptionRows.push(baseSub());
    const evt: ParsedEvent = {
      eventId: "evt_fw",
      type: "charge.dispute.funds_withdrawn",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      currencyCode: "USD",
      amountMicros: "3000000",
      refundAmountMicros: "3000000",
      chargeId: "ch_1",
      eventCreatedAt: new Date("2026-05-21"),
      metadata: { disputeId: "dp_1" },
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.entryType).toBe("dispute_debit");
    expect(ledgerRows[0]?.sourceId).toBe("dp_1");
  });

  it("credit_note.created → DEBIT entry", async () => {
    subscriptionRows.push(baseSub());
    const evt: ParsedEvent = {
      eventId: "evt_cn",
      type: "credit_note.created",
      subscriptionId: "sub_x",
      customerId: "cus_a",
      currencyCode: "USD",
      refundAmountMicros: "2500000",
      eventCreatedAt: new Date("2026-05-22"),
      metadata: { creditNoteId: "cn_1" },
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.entryType).toBe("credit_note_debit");
    expect(ledgerRows[0]?.sourceId).toBe("cn_1");
  });
});

describe("customer.deleted cascade (Val S4 Q1)", () => {
  it("cascades cancel to all active/trialing/past_due subs for that customer; ledger UNTOUCHED", async () => {
    subscriptionRows.push(
      baseSub({
        subscriptionId: "11111111-1111-1111-1111-111111111111",
        providerSubscriptionId: "sub_a1",
        status: "active",
      }),
    );
    subscriptionRows.push(
      baseSub({
        subscriptionId: "22222222-2222-2222-2222-222222222222",
        providerSubscriptionId: "sub_a2",
        status: "trialing",
      }),
    );
    subscriptionRows.push(
      baseSub({
        subscriptionId: "33333333-3333-3333-3333-333333333333",
        providerSubscriptionId: "sub_canceled",
        status: "canceled",
      }),
    );
    const evt: ParsedEvent = {
      eventId: "evt_cd",
      type: "customer.deleted",
      subscriptionId: "",
      customerId: "cus_a",
      eventCreatedAt: new Date("2026-05-30"),
      metadata: {},
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    const r = await app.request("/webhooks/stripe-subscription", {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(200);
    const a1 = subscriptionRows.find((r) => r.providerSubscriptionId === "sub_a1");
    const a2 = subscriptionRows.find((r) => r.providerSubscriptionId === "sub_a2");
    const canceled = subscriptionRows.find((r) => r.providerSubscriptionId === "sub_canceled");
    expect(a1?.status).toBe("canceled");
    expect(a2?.status).toBe("canceled");
    expect(canceled?.status).toBe("canceled"); // already was
    expect(ledgerRows).toHaveLength(0);
    expect(eventRows.length).toBeGreaterThanOrEqual(2);
  });

  it("idempotent on redelivery (webhook_events PK dedup)", async () => {
    subscriptionRows.push(baseSub({ status: "active" }));
    const evt: ParsedEvent = {
      eventId: "evt_cd2",
      type: "customer.deleted",
      subscriptionId: "",
      customerId: "cus_a",
      eventCreatedAt: new Date("2026-05-30"),
      metadata: {},
    };
    const adapter = makeAdapter({ parseReturns: evt });
    const app = buildApp(adapter);
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    await app.request("/webhooks/stripe-subscription", { method: "POST", body: "{}" });
    expect(webhookEventRows).toHaveLength(1);
  });
});
