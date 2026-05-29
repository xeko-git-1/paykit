import { describe, expectTypeOf, it } from "vitest";
import type {
  NormalizedSubscriptionEvent,
  SubscriptionResult,
} from "../src/subscriptions/index.js";

describe("Last-write-wins predicate fields (RT F9)", () => {
  it("SubscriptionResult carries lastEventCreated (Date) for adapter→cache merge", () => {
    expectTypeOf<SubscriptionResult>().toMatchTypeOf<{
      readonly lastEventCreated: Date;
    }>();
  });

  it("NormalizedSubscriptionEvent carries eventCreatedAt (Date) for webhook ordering", () => {
    expectTypeOf<NormalizedSubscriptionEvent>().toMatchTypeOf<{
      readonly eventCreatedAt: Date;
    }>();
  });
});
