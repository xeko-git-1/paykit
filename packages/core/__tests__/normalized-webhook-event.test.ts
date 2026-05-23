import { describe, expectTypeOf, it } from "vitest";
import type { NormalizedWebhookEvent, WebhookEventType } from "../src/adapters/index.js";

describe("WebhookEventType discriminated union", () => {
  it("is one of: payment.completed | payment.failed | payment.expired | payment.refunded | unknown", () => {
    expectTypeOf<WebhookEventType>().toEqualTypeOf<
      "payment.completed" | "payment.failed" | "payment.expired" | "payment.refunded" | "unknown"
    >();
  });
});

describe("NormalizedWebhookEvent shape", () => {
  it("requires eventId, type, providerRef", () => {
    expectTypeOf<NormalizedWebhookEvent>().toMatchTypeOf<{
      readonly eventId: string;
      readonly type: WebhookEventType;
      readonly providerRef: string;
    }>();
  });

  it("optional amountMicros (string), currencyCode, refundAmountMicros", () => {
    expectTypeOf<NormalizedWebhookEvent>().toMatchTypeOf<{
      readonly amountMicros?: string;
      readonly currencyCode?: string;
      readonly refundAmountMicros?: string;
    }>();
  });

  it("includes metadata Record<string, unknown> for adapter-specific fields", () => {
    expectTypeOf<NormalizedWebhookEvent>().toMatchTypeOf<{
      readonly metadata: Record<string, unknown>;
    }>();
  });
});
