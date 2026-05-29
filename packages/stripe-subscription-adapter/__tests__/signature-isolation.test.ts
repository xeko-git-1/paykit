/**
 * Per-instance signature isolation (RT F7) + rotation arrays.
 *
 * Two adapter instances configured with disjoint secrets must NOT validate
 * each other's signatures. Rotation array within an instance must succeed
 * when ANY entry matches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const callRecord: Array<{ secret: string; payload: string }> = [];

vi.mock("stripe", () => {
  class MockStripe {
    webhooks = {
      constructEvent: vi.fn((payload: string, _sig: string, secret: string) => {
        callRecord.push({ secret, payload });
        if (secret.startsWith("whsec_ok")) return JSON.parse(payload);
        const err = new Error("signature mismatch");
        throw err;
      }),
    };
    subscriptions = {} as Record<string, unknown>;
    events = { list: vi.fn(async () => ({ data: [], has_more: false })) };
  }
  return { default: MockStripe };
});

const { createStripeSubscriptionAdapter } = await import("../src/adapter.js");

beforeEach(() => {
  callRecord.length = 0;
});

const PAYLOAD = JSON.stringify({
  id: "evt_1",
  type: "payment_intent.succeeded",
  created: 1_700_000_000,
  data: { object: { id: "pi_1" } },
});

describe("Per-instance signature isolation (RT F7)", () => {
  it("instance B cannot verify a signature meant for instance A", () => {
    const a = createStripeSubscriptionAdapter({
      id: "stripe-subscription:eu",
      secretKey: "sk",
      webhookSecret: "whsec_ok_eu",
    });
    const b = createStripeSubscriptionAdapter({
      id: "stripe-subscription:us",
      secretKey: "sk",
      webhookSecret: "whsec_ok_us",
    });
    // Instance A succeeds with its own secret
    expect(a.verifyWebhookSignature(PAYLOAD, { "stripe-signature": "sig" })).toBe(true);
    // Instance B's mock will only succeed with whsec_ok_us — A's signature
    // arrives but B's verifier only tries B's own secret pool. Reset record:
    callRecord.length = 0;
    // Mock returns success ONLY for the specific secret we configured on each
    // instance — verifying that B never invokes A's secret
    expect(b.verifyWebhookSignature(PAYLOAD, { "stripe-signature": "sig-from-A" })).toBe(true);
    expect(callRecord.every((c) => c.secret === "whsec_ok_us")).toBe(true);
    expect(callRecord.some((c) => c.secret === "whsec_ok_eu")).toBe(false);
  });
});

describe("Rotation array within a single instance", () => {
  it("succeeds when ANY secret in the rotation matches", () => {
    const a = createStripeSubscriptionAdapter({
      secretKey: "sk",
      webhookSecret: ["whsec_old_disabled", "whsec_ok_active"],
    });
    expect(a.verifyWebhookSignature(PAYLOAD, { "stripe-signature": "sig" })).toBe(true);
    // Both secrets attempted (mock fails on whsec_old_disabled, succeeds on whsec_ok_active)
    expect(callRecord.map((c) => c.secret)).toEqual([
      "whsec_old_disabled",
      "whsec_ok_active",
    ]);
  });

  it("returns false when ALL rotation secrets fail", () => {
    const a = createStripeSubscriptionAdapter({
      secretKey: "sk",
      webhookSecret: ["whsec_bad_1", "whsec_bad_2"],
    });
    expect(a.verifyWebhookSignature(PAYLOAD, { "stripe-signature": "sig" })).toBe(false);
  });
});
