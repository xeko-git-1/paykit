import { describe, expect, expectTypeOf, it } from "vitest";
import type { DbOrTx } from "@vibecc/paykit-auth-core/db/client.js";
import * as pendingRefundRepo from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";

describe("pendingRefundRepo public API", () => {
  it("exposes lifecycle helpers", () => {
    expect(typeof pendingRefundRepo.createPendingRefund).toBe("function");
    expect(typeof pendingRefundRepo.markProcessing).toBe("function");
    expect(typeof pendingRefundRepo.markCompleted).toBe("function");
    expect(typeof pendingRefundRepo.markFailed).toBe("function");
    expect(typeof pendingRefundRepo.markTimedOut).toBe("function");
    expect(typeof pendingRefundRepo.recordPollAttempt).toBe("function");
    expect(typeof pendingRefundRepo.listPollable).toBe("function");
  });

  it("createPendingRefund accepts DbOrTx", () => {
    expectTypeOf(pendingRefundRepo.createPendingRefund).parameter(0).toEqualTypeOf<DbOrTx>();
  });

  it("PendingRefundState is the V1.5 5-state enum", () => {
    expectTypeOf<pendingRefundRepo.PendingRefundState>().toEqualTypeOf<
      "queued" | "processing" | "completed" | "failed" | "timed_out"
    >();
  });
});
