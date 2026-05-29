import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Discrepancy,
  PerProviderStats,
  ReconciliationSummary,
} from "../src/reconcile/summary.js";

describe("reconciler typing widened to string provider (Phase 0a — RT F2)", () => {
  it("Discrepancy.provider is string (no longer 'stripe' | 'sepay')", () => {
    expectTypeOf<Discrepancy["provider"]>().toEqualTypeOf<string>();
  });

  it("ReconciliationSummary.perProvider is Record<string, PerProviderStats>", () => {
    expectTypeOf<ReconciliationSummary["perProvider"]>().toEqualTypeOf<
      Record<string, PerProviderStats>
    >();
  });

  it("V3 adapter id (e.g. 'coinbase-commerce') is now type-assignable as provider", () => {
    const sample: Discrepancy = {
      type: "matched",
      provider: "coinbase-commerce",
      transactionId: null,
      providerRef: null,
      paykitAmountMicros: null,
      providerAmountMicros: null,
    };
    expect(sample.provider).toBe("coinbase-commerce");
  });

  it("perProvider accepts arbitrary adapter ids without unsafe casts", () => {
    const stats: PerProviderStats = {
      matched: 1,
      paykitMissing: 0,
      providerMissing: 0,
      amountMismatch: 0,
      refundDrift: 0,
    };
    const summary: Record<string, PerProviderStats> = {
      "test-x": stats,
      nowpayments: stats,
      bitpay: stats,
    };
    expect(Object.keys(summary)).toHaveLength(3);
  });
});
