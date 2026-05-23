import { describe, expectTypeOf, it } from "vitest";
import type { RefundInput, RefundResult, RefundState } from "../src/adapters/index.js";

describe("RefundState union", () => {
  it("is 'completed' | 'pending' | 'failed' | 'unsupported'", () => {
    expectTypeOf<RefundState>().toEqualTypeOf<"completed" | "pending" | "failed" | "unsupported">();
  });
});

describe("RefundInput shape", () => {
  it("requires transactionId + amountMicros + idempotencyKey + reason", () => {
    expectTypeOf<RefundInput>().toMatchTypeOf<{
      readonly transactionId: string;
      readonly amountMicros: bigint;
      readonly idempotencyKey: string;
      readonly reason: string;
    }>();
  });

  it("optional providerRef hint for adapter (avoids extra DB query)", () => {
    expectTypeOf<RefundInput>().toMatchTypeOf<{
      readonly providerRef?: string;
    }>();
  });
});

describe("RefundResult shape", () => {
  it("requires state + optional providerRefundId + optional error", () => {
    expectTypeOf<RefundResult>().toMatchTypeOf<{
      readonly state: RefundState;
      readonly providerRefundId?: string;
      readonly error?: { readonly providerCode?: string; readonly message: string };
    }>();
  });
});
