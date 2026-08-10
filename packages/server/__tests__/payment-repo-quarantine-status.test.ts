import { describe, expect, expectTypeOf, it } from "vitest";
import type { DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { updateTransactionStatus } from "@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js";

describe("payment.repo updateTransactionStatus signature (Phase 0a — Val D3)", () => {
  it("accepts 'quarantine' in the status union (migration 010 enum extension)", () => {
    expectTypeOf(updateTransactionStatus).parameter(2).toEqualTypeOf<
      "pending" | "completed" | "failed" | "refunded" | "expired" | "quarantine"
    >();
  });

  it("first parameter is DbOrTx (works inside webhook-router transaction)", () => {
    expectTypeOf(updateTransactionStatus).parameter(0).toEqualTypeOf<DbOrTx>();
  });

  it("preserves V1 status vocabulary alongside the new value", () => {
    // Compile-time guard: passing each V1 status remains type-correct.
    // Runtime no-op; assertion is purely on the type system.
    type V1Status = "pending" | "completed" | "failed" | "refunded" | "expired";
    type ParamStatus = Parameters<typeof updateTransactionStatus>[2];
    type V1Subset = V1Status extends ParamStatus ? true : false;
    const v1Subset: V1Subset = true;
    expect(v1Subset).toBe(true);
  });
});
