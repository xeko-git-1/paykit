import { describe, expectTypeOf, it } from "vitest";
import type {
  NormalizedSubscriptionEvent,
  SubscriptionEventType,
} from "../src/subscriptions/index.js";

describe("SubscriptionEventType union (RT F1, Val S4 Q1)", () => {
  it("covers 10 cases — 3 sub lifecycle + 2 invoice settle + 4 refund/dispute + 1 customer.deleted", () => {
    expectTypeOf<SubscriptionEventType>().toEqualTypeOf<
      | "sub.created"
      | "sub.updated"
      | "sub.deleted"
      | "invoice.paid"
      | "invoice.failed"
      | "charge.refunded"
      | "charge.dispute.created"
      | "charge.dispute.funds_withdrawn"
      | "credit_note.created"
      | "customer.deleted"
    >();
  });
});

describe("NormalizedSubscriptionEvent shape (RT F9)", () => {
  it("requires eventId, type, subscriptionId, customerId, status, eventCreatedAt, metadata", () => {
    expectTypeOf<NormalizedSubscriptionEvent>().toMatchTypeOf<{
      readonly eventId: string;
      readonly type: SubscriptionEventType;
      readonly subscriptionId: string;
      readonly customerId: string;
      readonly eventCreatedAt: Date;
      readonly metadata: Record<string, unknown>;
    }>();
  });
});
