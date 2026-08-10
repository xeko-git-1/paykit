import { WebhookSignatureError } from "@xeko-git-1/paykit";
import { describe, expect, it, vi } from "vitest";

vi.mock("stripe", () => {
  class MockStripe {
    checkout = { sessions: { create: vi.fn() } };
    webhooks = {
      constructEvent: vi.fn((payload: string, sig: string, secret: string) => {
        if (sig === `signed_with_${secret}`) {
          return { id: "evt_1", type: "checkout.session.completed", data: { object: {} } };
        }
        throw new Error(`bad sig ${sig} != ${secret}`);
      }),
    };
  }
  return { default: MockStripe };
});

import { StripeClient } from "../src/providers/stripe/client.js";

const baseCfg = {
  secretKey: "sk",
  successUrl: "",
  cancelUrl: "",
};

describe("StripeClient webhook secret rotation (string | string[])", () => {
  it("single secret: works as before", () => {
    const c = new StripeClient({ ...baseCfg, webhookSecret: "whsec_v1" });
    const evt = c.constructWebhookEvent("body", "signed_with_whsec_v1");
    expect(evt.id).toBe("evt_1");
  });

  it("array [old, new]: tries each, succeeds with old", () => {
    const c = new StripeClient({ ...baseCfg, webhookSecret: ["whsec_v1_old", "whsec_v2_new"] });
    const evt = c.constructWebhookEvent("body", "signed_with_whsec_v1_old");
    expect(evt.id).toBe("evt_1");
  });

  it("array: succeeds with new", () => {
    const c = new StripeClient({ ...baseCfg, webhookSecret: ["whsec_v1_old", "whsec_v2_new"] });
    const evt = c.constructWebhookEvent("body", "signed_with_whsec_v2_new");
    expect(evt.id).toBe("evt_1");
  });

  it("all secrets fail: throws WebhookSignatureError", () => {
    const c = new StripeClient({ ...baseCfg, webhookSecret: ["whsec_v1", "whsec_v2"] });
    expect(() => c.constructWebhookEvent("body", "signed_with_other")).toThrow(
      WebhookSignatureError,
    );
  });

  it("empty array: throws WebhookSignatureError immediately", () => {
    const c = new StripeClient({ ...baseCfg, webhookSecret: [] });
    expect(() => c.constructWebhookEvent("body", "anything")).toThrow(WebhookSignatureError);
  });
});
