import { describe, expectTypeOf, it } from "vitest";
import type { SubscriptionAdapter } from "../src/subscriptions/index.js";

describe("SubscriptionAdapter interface shape (RT 15f)", () => {
  it("declares 9 methods (no displayName) — id, subscribe, cancel, upgrade, listForCustomer, getById, verifyWebhookSignature, parseSubscriptionEvent, syncSubscription", () => {
    expectTypeOf<SubscriptionAdapter>().toMatchTypeOf<{
      readonly id: string;
      subscribe: (...args: never[]) => unknown;
      cancel: (...args: never[]) => unknown;
      upgrade: (...args: never[]) => unknown;
      listForCustomer: (...args: never[]) => unknown;
      getById: (...args: never[]) => unknown;
      verifyWebhookSignature: (...args: never[]) => unknown;
      parseSubscriptionEvent: (...args: never[]) => unknown;
      syncSubscription: (...args: never[]) => unknown;
    }>();
  });

  it("does NOT include displayName (cut per RT 15f — no consumer)", () => {
    type Keys = keyof SubscriptionAdapter;
    type HasDisplayName = "displayName" extends Keys ? true : false;
    expectTypeOf<HasDisplayName>().toEqualTypeOf<false>();
  });
});
