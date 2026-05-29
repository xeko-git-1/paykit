/**
 * Adapter behavior tests with mocked Stripe SDK. Verifies subscribe/cancel/upgrade
 * forward idempotency keys verbatim (RT F4/F8) and toResult shape. signature
 * isolation across instances tested in signature-isolation.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeCalls = {
  create: vi.fn(),
  cancel: vi.fn(),
  update: vi.fn(),
  retrieve: vi.fn(),
  list: vi.fn(),
  events: vi.fn(),
  constructEvent: vi.fn(),
};

vi.mock("stripe", () => {
  class MockStripe {
    subscriptions = {
      create: stripeCalls.create,
      cancel: stripeCalls.cancel,
      update: stripeCalls.update,
      retrieve: stripeCalls.retrieve,
      list: stripeCalls.list,
    };
    events = { list: stripeCalls.events };
    webhooks = { constructEvent: stripeCalls.constructEvent };
  }
  return { default: MockStripe };
});

const { createStripeSubscriptionAdapter } = await import("../src/adapter.js");

const baseSub = {
  id: "sub_x",
  customer: "cus_abc",
  status: "active" as const,
  cancel_at_period_end: false,
  items: { data: [{ id: "si_1", price: { id: "price_p1" }, current_period_end: 1_700_010_000 }] },
  latest_invoice: "in_1",
  currency: "usd",
  created: 1_700_000_000,
};

beforeEach(() => {
  for (const fn of Object.values(stripeCalls)) fn.mockReset();
  stripeCalls.events.mockResolvedValue({ data: [], has_more: false });
});

describe("subscribe forwards idempotency_key (RT F4/F8)", () => {
  it("calls stripe.subscriptions.create with caller-supplied idempotencyKey", async () => {
    stripeCalls.create.mockResolvedValueOnce(baseSub);
    const adapter = createStripeSubscriptionAdapter({
      secretKey: "sk_test",
      webhookSecret: "whsec_a",
    });
    const result = await adapter.subscribe({
      customerId: "cus_abc",
      priceId: "price_p1",
      paykitTenantId: "00000000-0000-0000-0000-000000000001",
      idempotencyKey: "key-abc",
    });
    expect(stripeCalls.create).toHaveBeenCalledTimes(1);
    const [params, opts] = stripeCalls.create.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect((params.metadata as Record<string, string>).paykit_tenant_id).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(opts.idempotencyKey).toBe("key-abc");
    expect(result.id).toBe("sub_x");
    expect(result.status).toBe("active");
    expect(result.priceId).toBe("price_p1");
    expect(result.latestInvoiceId).toBe("in_1");
  });

  it("converts trialDays > 0 to trial_period_days; omits when 0/undefined", async () => {
    stripeCalls.create.mockResolvedValue(baseSub);
    const adapter = createStripeSubscriptionAdapter({
      secretKey: "sk",
      webhookSecret: "w",
    });

    await adapter.subscribe({
      customerId: "c",
      priceId: "p",
      paykitTenantId: "t",
      trialDays: 7,
    });
    expect((stripeCalls.create.mock.calls[0]?.[0] as Record<string, unknown>).trial_period_days).toBe(7);

    stripeCalls.create.mockClear();
    await adapter.subscribe({ customerId: "c", priceId: "p", paykitTenantId: "t", trialDays: 0 });
    expect(
      (stripeCalls.create.mock.calls[0]?.[0] as Record<string, unknown>).trial_period_days,
    ).toBeUndefined();

    stripeCalls.create.mockClear();
    await adapter.subscribe({ customerId: "c", priceId: "p", paykitTenantId: "t" });
    expect(
      (stripeCalls.create.mock.calls[0]?.[0] as Record<string, unknown>).trial_period_days,
    ).toBeUndefined();
  });
});

describe("cancel forwards idempotency_key + chooses correct method", () => {
  it("atPeriodEnd=true → subscriptions.update({cancel_at_period_end:true})", async () => {
    stripeCalls.update.mockResolvedValueOnce({ ...baseSub, cancel_at_period_end: true });
    const adapter = createStripeSubscriptionAdapter({ secretKey: "sk", webhookSecret: "w" });
    const r = await adapter.cancel({
      subscriptionId: "sub_x",
      atPeriodEnd: true,
      idempotencyKey: "k1",
    });
    expect(stripeCalls.update).toHaveBeenCalledWith(
      "sub_x",
      { cancel_at_period_end: true },
      { idempotencyKey: "k1" },
    );
    expect(r.cancelAtPeriodEnd).toBe(true);
  });

  it("atPeriodEnd=false → subscriptions.cancel", async () => {
    stripeCalls.cancel.mockResolvedValueOnce({ ...baseSub, status: "canceled" });
    const adapter = createStripeSubscriptionAdapter({ secretKey: "sk", webhookSecret: "w" });
    await adapter.cancel({ subscriptionId: "sub_x", atPeriodEnd: false, idempotencyKey: "k2" });
    expect(stripeCalls.cancel).toHaveBeenCalledWith("sub_x", undefined, { idempotencyKey: "k2" });
  });
});

describe("upgrade forwards idempotency_key + sets prorate", () => {
  it("calls update with proration_behavior:'create_prorations'", async () => {
    stripeCalls.retrieve.mockResolvedValueOnce(baseSub);
    stripeCalls.update.mockResolvedValueOnce({
      ...baseSub,
      items: { data: [{ id: "si_1", price: { id: "price_p2" }, current_period_end: 1_700_010_000 }] },
    });
    const adapter = createStripeSubscriptionAdapter({ secretKey: "sk", webhookSecret: "w" });
    const r = await adapter.upgrade({
      subscriptionId: "sub_x",
      newPriceId: "price_p2",
      idempotencyKey: "u1",
    });
    const [, params, opts] = stripeCalls.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect((params.items as Array<Record<string, unknown>>)[0]?.price).toBe("price_p2");
    expect(params.proration_behavior).toBe("create_prorations");
    expect(opts.idempotencyKey).toBe("u1");
    expect(r.priceId).toBe("price_p2");
  });
});

describe("findLatestEventCreated (RT F2 — replaces fictional Stripe.updated)", () => {
  it("returns max event.created across pages for matching subscription id", async () => {
    stripeCalls.events
      .mockResolvedValueOnce({
        data: [
          { id: "evt_1", created: 1700, data: { object: { id: "sub_x" } } },
          { id: "evt_2", created: 1900, data: { object: { id: "sub_other" } } },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          { id: "evt_3", created: 2400, data: { object: { id: "sub_x" } } },
          { id: "evt_4", created: 2100, data: { object: { subscription: "sub_x" } } },
        ],
        has_more: false,
      });
    const adapter = createStripeSubscriptionAdapter({ secretKey: "sk", webhookSecret: "w" });
    const r = await adapter.findLatestEventCreated("sub_x");
    expect(r?.getTime()).toBe(2400 * 1000);
  });

  it("returns null when no matching events", async () => {
    stripeCalls.events.mockResolvedValueOnce({ data: [], has_more: false });
    const adapter = createStripeSubscriptionAdapter({ secretKey: "sk", webhookSecret: "w" });
    const r = await adapter.findLatestEventCreated("sub_y");
    expect(r).toBeNull();
  });
});

describe("getById null on resource_missing", () => {
  it("returns null when Stripe replies resource_missing", async () => {
    stripeCalls.retrieve.mockRejectedValueOnce({ code: "resource_missing" });
    const adapter = createStripeSubscriptionAdapter({ secretKey: "sk", webhookSecret: "w" });
    const r = await adapter.getById("sub_zzz");
    expect(r).toBeNull();
  });
});
