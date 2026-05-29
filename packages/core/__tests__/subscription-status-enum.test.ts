import { describe, expectTypeOf, it } from "vitest";
import type { SubscriptionStatus } from "../src/subscriptions/index.js";

describe("SubscriptionStatus literal union (RT F3)", () => {
  it("covers all 8 Stripe subscription statuses", () => {
    expectTypeOf<SubscriptionStatus>().toEqualTypeOf<
      | "active"
      | "trialing"
      | "past_due"
      | "canceled"
      | "incomplete"
      | "unpaid"
      | "incomplete_expired"
      | "paused"
    >();
  });

  it("rejects unknown literal at type level", () => {
    // @ts-expect-error — 'pending' is not a valid SubscriptionStatus
    const _bad: SubscriptionStatus = "pending";
    void _bad;
  });
});
