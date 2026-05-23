import { describe, expect, it, vi } from "vitest";

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: vi.fn(async (opts: { metadata?: Record<string, string> }) => ({
          id: "cs_test_abc",
          url: "https://checkout.stripe.com/c/pay/cs_test_abc",
          metadata: opts.metadata,
        })),
        retrieve: vi.fn(),
        list: vi.fn(),
      },
    };
    refunds = { create: vi.fn() };
    webhooks = {
      constructEvent: vi.fn((payload: string, sig: string, secret: string) => {
        if (sig === `sig_${secret}`) {
          return JSON.parse(payload);
        }
        throw new Error("invalid signature");
      }),
    };
  }
  return { default: MockStripe };
});

import { createStripeAdapter } from "../src/adapter.js";

const baseConfig = {
  secretKey: "sk_test_x",
  webhookSecret: "whsec_v1",
  successUrl: "https://app.example/billing/success",
  cancelUrl: "https://app.example/billing/checkout",
};

describe("createStripeAdapter — adapter contract conformance", () => {
  const adapter = createStripeAdapter(baseConfig);

  it("id defaults to 'stripe'", () => {
    expect(adapter.id).toBe("stripe");
  });

  it("supports custom id (multi-instance)", () => {
    const eu = createStripeAdapter({ ...baseConfig, id: "stripe:eu" });
    expect(eu.id).toBe("stripe:eu");
  });

  it("supportedCurrencies = ['USD']", () => {
    expect(adapter.supportedCurrencies).toEqual(["USD"]);
  });

  it("checkoutMode = 'redirect'", () => {
    expect(adapter.checkoutMode).toBe("redirect");
  });

  it("displayName = 'Stripe'", () => {
    expect(adapter.displayName).toBe("Stripe");
  });
});

describe("createStripeAdapter — createCheckout", () => {
  it("converts micros to cents (× 1/10000) and returns webUrl", async () => {
    const adapter = createStripeAdapter(baseConfig);
    const result = await adapter.createCheckout({
      transactionId: "tx-1",
      tenantId: "t-1",
      ownerId: "o-1",
      amountMicros: 100_000_000n, // $10
      currencyCode: "USD",
    });
    expect(result.webUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_abc");
    expect(result.providerSessionId).toBe("cs_test_abc");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("rejects non-USD currency", async () => {
    const adapter = createStripeAdapter(baseConfig);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-1",
        tenantId: "t-1",
        ownerId: "o-1",
        amountMicros: 100_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD only/);
  });
});

describe("createStripeAdapter — webhook signature rotation", () => {
  it("verifies with single secret string", () => {
    const adapter = createStripeAdapter({ ...baseConfig, webhookSecret: "whsec_v1" });
    const event = JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } });
    expect(adapter.verifyWebhookSignature(event, { "stripe-signature": "sig_whsec_v1" })).toBe(
      true,
    );
  });

  it("verifies with array of secrets (rotation grace)", () => {
    const adapter = createStripeAdapter({
      ...baseConfig,
      webhookSecret: ["whsec_old", "whsec_new"],
    });
    const event = JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } });
    expect(adapter.verifyWebhookSignature(event, { "stripe-signature": "sig_whsec_old" })).toBe(
      true,
    );
    expect(adapter.verifyWebhookSignature(event, { "stripe-signature": "sig_whsec_new" })).toBe(
      true,
    );
  });

  it("rejects bad signature", () => {
    const adapter = createStripeAdapter(baseConfig);
    const event = JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } });
    expect(adapter.verifyWebhookSignature(event, { "stripe-signature": "wrong" })).toBe(false);
  });
});

describe("createStripeAdapter — parseWebhookPayload", () => {
  const adapter = createStripeAdapter(baseConfig);

  it("checkout.session.completed (paid USD) → payment.completed event", () => {
    const event = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_x",
          payment_status: "paid",
          amount_total: 1000, // $10
          currency: "usd",
          metadata: { paykitTransactionId: "tx-1", tenantId: "t-1", ownerId: "o-1" },
        },
      },
    });
    const headers = { "stripe-signature": "sig_whsec_v1" };
    const result = adapter.parseWebhookPayload(event, headers);
    expect(result?.type).toBe("payment.completed");
    expect(result?.providerRef).toBe("cs_x");
    expect(result?.amountMicros).toBe("10000000"); // 1000 cents × 10000 = 10M micros
    expect(result?.currencyCode).toBe("USD");
    expect((result?.metadata as { fixVersion?: string })?.fixVersion).toBe("v2_micros_corrected");
  });

  it("checkout.session.completed (unpaid) → null", () => {
    const event = JSON.stringify({
      id: "evt_2",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_y",
          payment_status: "unpaid",
          amount_total: 1000,
          currency: "usd",
          metadata: {},
        },
      },
    });
    const result = adapter.parseWebhookPayload(event, { "stripe-signature": "sig_whsec_v1" });
    expect(result).toBeNull();
  });

  it("charge.refunded → payment.refunded event", () => {
    const event = JSON.stringify({
      id: "evt_3",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          amount_refunded: 500,
          currency: "usd",
          metadata: { checkoutSessionId: "cs_orig" },
          refunds: { data: [{ id: "re_1" }] },
        },
      },
    });
    const result = adapter.parseWebhookPayload(event, { "stripe-signature": "sig_whsec_v1" });
    expect(result?.type).toBe("payment.refunded");
    expect(result?.providerRef).toBe("cs_orig");
    expect(result?.refundAmountMicros).toBe("5000000");
  });

  it("checkout.session.expired → payment.expired event", () => {
    const event = JSON.stringify({
      id: "evt_4",
      type: "checkout.session.expired",
      data: { object: { id: "cs_exp" } },
    });
    const result = adapter.parseWebhookPayload(event, { "stripe-signature": "sig_whsec_v1" });
    expect(result?.type).toBe("payment.expired");
    expect(result?.providerRef).toBe("cs_exp");
  });

  it("unhandled event type → null (e.g. customer.created in V1.5)", () => {
    const event = JSON.stringify({
      id: "evt_5",
      type: "customer.created",
      data: { object: {} },
    });
    expect(adapter.parseWebhookPayload(event, { "stripe-signature": "sig_whsec_v1" })).toBeNull();
  });

  it("bad signature → null (silent reject)", () => {
    const event = JSON.stringify({ id: "evt_6", type: "ping", data: { object: {} } });
    expect(adapter.parseWebhookPayload(event, { "stripe-signature": "bad" })).toBeNull();
  });
});
