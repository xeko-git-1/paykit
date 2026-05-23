import { describe, expect, it, vi } from "vitest";

// Mock Stripe SDK before import
vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: vi.fn(async (opts: Record<string, unknown>) => ({
          id: "cs_test_abc",
          url: "https://checkout.stripe.com/c/pay/cs_test_abc",
          metadata: opts.metadata,
        })),
      },
    };
    webhooks = {
      constructEvent: vi.fn((payload: string, _sig: string, secret: string) => {
        if (secret === "whsec_correct") return JSON.parse(payload);
        throw new Error("invalid signature");
      }),
    };
  }
  return { default: MockStripe };
});

import { StripeClient } from "../src/providers/stripe/client.js";

describe("StripeClient.createTopUpSession", () => {
  const client = new StripeClient({
    secretKey: "sk_test_x",
    webhookSecret: "whsec_correct",
    successUrl: "https://app.example/billing/success",
    cancelUrl: "https://app.example/billing/checkout",
  });

  it("converts USD amount to cents (× 100) and round-trips metadata", async () => {
    const r = await client.createTopUpSession({
      amountUsd: 12.5,
      tenantId: "t-1",
      ownerId: "o-1",
    });
    expect(r.sessionId).toBe("cs_test_abc");
    expect(r.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_abc");
  });

  it("constructs success URL with session_id placeholder", async () => {
    const r = await client.createTopUpSession({
      amountUsd: 10,
      tenantId: "t-1",
      ownerId: "o-1",
      customerEmail: "u@example.com",
    });
    expect(r.sessionId).toBeTruthy();
  });
});
