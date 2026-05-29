import { describe, expectTypeOf, it } from "vitest";
import type {
  NormalizedWebhookEvent,
  WebhookEventType,
} from "@vibecc/paykit";

describe("V3 core webhook types extended (Phase 0b — Val Session 1 D2 + D3)", () => {
  it("WebhookEventType includes V3 'payment.underpaid' (RT F5)", () => {
    type HasUnderpaid = "payment.underpaid" extends WebhookEventType ? true : false;
    expectTypeOf<HasUnderpaid>().toEqualTypeOf<true>();
  });

  it("WebhookEventType includes V3 'payment.amount_mismatch' (RT F6)", () => {
    type HasAmountMismatch = "payment.amount_mismatch" extends WebhookEventType ? true : false;
    expectTypeOf<HasAmountMismatch>().toEqualTypeOf<true>();
  });

  it("preserves V1.5/V2 vocabulary (no destructive removal)", () => {
    type V1Vocab =
      | "payment.completed"
      | "payment.failed"
      | "payment.expired"
      | "payment.refunded"
      | "unknown";
    type V1Subset = V1Vocab extends WebhookEventType ? true : false;
    expectTypeOf<V1Subset>().toEqualTypeOf<true>();
  });

  it("NormalizedWebhookEvent gains optional expectedAmountMicros for underpaid + amount_mismatch", () => {
    expectTypeOf<NormalizedWebhookEvent>().toHaveProperty("expectedAmountMicros");
  });
});
