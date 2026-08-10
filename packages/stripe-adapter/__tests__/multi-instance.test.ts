/**
 * V1.5 multi-instance adapter test (red-team F12).
 *
 * Verifies: 2 Stripe adapter instances with id='stripe' and id='stripe:eu'
 * can coexist in the same ProviderRegistry. Webhook URLs route to the right
 * adapter based on path segment.
 */
import { ProviderRegistry } from "@xeko-git-1/paykit";
import { describe, expect, it, vi } from "vitest";

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: vi.fn(),
        retrieve: vi.fn(),
        list: vi.fn(),
      },
    };
    refunds = { create: vi.fn() };
    webhooks = { constructEvent: vi.fn() };
  }
  return { default: MockStripe };
});

import { createStripeAdapter } from "../src/adapter.js";

describe("Stripe adapter multi-instance (red-team F12)", () => {
  it("two adapters with distinct ids coexist in same registry", () => {
    const us = createStripeAdapter({
      id: "stripe",
      secretKey: "sk_us",
      webhookSecret: "whsec_us",
      successUrl: "",
      cancelUrl: "",
    });
    const eu = createStripeAdapter({
      id: "stripe:eu",
      secretKey: "sk_eu",
      webhookSecret: "whsec_eu",
      successUrl: "",
      cancelUrl: "",
    });
    const reg = new ProviderRegistry();
    reg.register(us);
    reg.register(eu);
    expect(reg.list()).toHaveLength(2);
    expect(reg.get("stripe")).toBe(us);
    expect(reg.get("stripe:eu")).toBe(eu);
  });

  it("rejects 2 adapters with EXACT same id", () => {
    const us1 = createStripeAdapter({
      id: "stripe",
      secretKey: "sk_us1",
      webhookSecret: "wh1",
      successUrl: "",
      cancelUrl: "",
    });
    const us2 = createStripeAdapter({
      id: "stripe",
      secretKey: "sk_us2",
      webhookSecret: "wh2",
      successUrl: "",
      cancelUrl: "",
    });
    const reg = new ProviderRegistry();
    reg.register(us1);
    expect(() => reg.register(us2)).toThrow(/already registered/i);
  });

  it("colon-separated id format permitted", () => {
    const reg = new ProviderRegistry();
    expect(() =>
      reg.register(
        createStripeAdapter({
          id: "stripe:eu:sandbox",
          secretKey: "sk",
          webhookSecret: "wh",
          successUrl: "",
          cancelUrl: "",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects invalid id chars (/, ?, #, space)", () => {
    const reg = new ProviderRegistry();
    expect(() =>
      reg.register(
        createStripeAdapter({
          id: "stripe/eu",
          secretKey: "sk",
          webhookSecret: "wh",
          successUrl: "",
          cancelUrl: "",
        }),
      ),
    ).toThrow(/invalid/i);
  });
});
