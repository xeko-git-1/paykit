import { describe, expectTypeOf, it } from "vitest";
import type {
  CreateSubscriptionInput,
  NormalizedSubscriptionEvent,
  SubscriptionResult,
} from "../src/subscriptions/index.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("V2 subscription types are immutable (readonly)", () => {
  it("CreateSubscriptionInput uses readonly fields — Mutable<…> is structurally different", () => {
    expectTypeOf<CreateSubscriptionInput>().not.toEqualTypeOf<Mutable<CreateSubscriptionInput>>();
  });

  it("SubscriptionResult uses readonly fields", () => {
    expectTypeOf<SubscriptionResult>().not.toEqualTypeOf<Mutable<SubscriptionResult>>();
  });

  it("NormalizedSubscriptionEvent uses readonly fields", () => {
    expectTypeOf<NormalizedSubscriptionEvent>().not.toEqualTypeOf<
      Mutable<NormalizedSubscriptionEvent>
    >();
  });
});
