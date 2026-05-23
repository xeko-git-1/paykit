import { describe, expect, it } from "vitest";
import {
  type Discrepancy,
  EMPTY_PER_PROVIDER,
  type ReconciliationSummary,
  summaryToJson,
} from "../src/reconcile/summary.js";

const baseSummary: ReconciliationSummary = {
  runId: "run-uuid-1",
  startedAt: new Date("2026-05-23T00:00:00Z"),
  completedAt: new Date("2026-05-23T00:01:00Z"),
  status: "completed",
  window: {
    since: new Date("2026-05-22T00:00:00Z"),
    until: new Date("2026-05-23T00:00:00Z"),
  },
  perProvider: { stripe: EMPTY_PER_PROVIDER, sepay: EMPTY_PER_PROVIDER },
  discrepancies: [],
};

describe("summaryToJson", () => {
  it("serializes Date fields as ISO strings (JSONB-safe)", () => {
    const json = summaryToJson(baseSummary);
    expect(json.startedAt).toBe("2026-05-23T00:00:00.000Z");
    expect((json.window as { since: string }).since).toBe("2026-05-22T00:00:00.000Z");
  });

  it("handles null completedAt (running state)", () => {
    const running: ReconciliationSummary = {
      ...baseSummary,
      completedAt: null,
      status: "running",
    };
    const json = summaryToJson(running);
    expect(json.completedAt).toBeNull();
  });

  it("caps discrepancies array at 1000 but preserves total count", () => {
    const many: Discrepancy[] = [];
    for (let i = 0; i < 1500; i++) {
      many.push({
        type: "paykit_missing",
        provider: "stripe",
        transactionId: null,
        providerRef: `cs_${i}`,
        paykitAmountMicros: null,
        providerAmountMicros: "100",
      });
    }
    const json = summaryToJson({ ...baseSummary, discrepancies: many });
    expect((json.discrepancies as Discrepancy[]).length).toBe(1000);
    expect(json.discrepancyTotal).toBe(1500);
  });

  it("serializes BigInt-free output (all numeric fields are MicrosString)", () => {
    const json = summaryToJson({
      ...baseSummary,
      discrepancies: [
        {
          type: "amount_mismatch",
          provider: "stripe",
          transactionId: "tx",
          providerRef: "cs_1",
          paykitAmountMicros: "1000001",
          providerAmountMicros: "1000000",
        },
      ],
    });
    // No BigInt anywhere; safe to JSON.stringify.
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

describe("EMPTY_PER_PROVIDER", () => {
  it("starts every counter at zero", () => {
    expect(EMPTY_PER_PROVIDER.matched).toBe(0);
    expect(EMPTY_PER_PROVIDER.paykitMissing).toBe(0);
    expect(EMPTY_PER_PROVIDER.providerMissing).toBe(0);
    expect(EMPTY_PER_PROVIDER.amountMismatch).toBe(0);
    expect(EMPTY_PER_PROVIDER.refundDrift).toBe(0);
  });
});
