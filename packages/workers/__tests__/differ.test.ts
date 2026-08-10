import { describe, expect, it } from "vitest";
import {
  type PaykitTxnSnapshot,
  type ProviderTxnRecord,
  diffPaykitVsProvider,
} from "../src/reconcile/differ.js";

const pk = (
  transactionId: string,
  providerRef: string | null,
  amountMicros: string,
  status: string,
  currencyCode = "USD",
): PaykitTxnSnapshot => ({ transactionId, providerRef, amountMicros, currencyCode, status });

const prov = (
  providerRef: string,
  amountMicros: string,
  refundedAmountMicros?: string,
): ProviderTxnRecord => ({
  providerRef,
  amountMicros,
  currencyCode: "USD",
  ...(refundedAmountMicros !== undefined ? { refundedAmountMicros } : {}),
});

describe("diffPaykitVsProvider", () => {
  it("matched: equal amounts on same providerRef", () => {
    const out = diffPaykitVsProvider(
      "stripe",
      [pk("tx-1", "cs_1", "1000000", "completed")],
      [prov("cs_1", "1000000")],
    );
    expect(out.stats.matched).toBe(1);
    expect(out.stats.paykitMissing).toBe(0);
    expect(out.stats.providerMissing).toBe(0);
    expect(out.discrepancies).toHaveLength(0);
  });

  it("paykit_missing: provider has tx, paykit doesn't", () => {
    const out = diffPaykitVsProvider("stripe", [], [prov("cs_orphan", "500000")]);
    expect(out.stats.paykitMissing).toBe(1);
    expect(out.discrepancies[0]?.type).toBe("paykit_missing");
    expect(out.discrepancies[0]?.providerRef).toBe("cs_orphan");
  });

  it("provider_missing: paykit has completed tx, provider doesn't", () => {
    const out = diffPaykitVsProvider("stripe", [pk("tx-1", "cs_x", "1000000", "completed")], []);
    expect(out.stats.providerMissing).toBe(1);
    expect(out.discrepancies[0]?.type).toBe("provider_missing");
  });

  it("provider_missing only counts completed/refunded paykit txns (skips pending)", () => {
    const out = diffPaykitVsProvider(
      "stripe",
      [pk("tx-pending", "cs_p", "1000000", "pending")],
      [],
    );
    expect(out.stats.providerMissing).toBe(0);
    expect(out.discrepancies).toHaveLength(0);
  });

  it("amount_mismatch: BigInt comparison catches even 1-micro drift", () => {
    const out = diffPaykitVsProvider(
      "stripe",
      [pk("tx-1", "cs_1", "1000001", "completed")],
      [prov("cs_1", "1000000")],
    );
    expect(out.stats.amountMismatch).toBe(1);
    expect(out.discrepancies[0]?.type).toBe("amount_mismatch");
    expect(out.discrepancies[0]?.paykitAmountMicros).toBe("1000001");
    expect(out.discrepancies[0]?.providerAmountMicros).toBe("1000000");
  });

  it("amount_mismatch handles Postgres numeric round-trip strings ('1000000.000000')", () => {
    const out = diffPaykitVsProvider(
      "stripe",
      [pk("tx-1", "cs_1", "1000000.000000", "completed")],
      [prov("cs_1", "1000000")],
    );
    expect(out.stats.matched).toBe(1);
  });

  it("refund_drift: provider shows refund but paykit status not 'refunded'", () => {
    const out = diffPaykitVsProvider(
      "stripe",
      [pk("tx-1", "cs_1", "1000000", "completed")],
      [prov("cs_1", "1000000", "1000000")],
    );
    expect(out.stats.refundDrift).toBe(1);
    expect(out.discrepancies[0]?.type).toBe("refund_drift");
  });

  it("no refund_drift when paykit status='refunded'", () => {
    const out = diffPaykitVsProvider(
      "stripe",
      [pk("tx-1", "cs_1", "1000000", "refunded")],
      [prov("cs_1", "1000000", "1000000")],
    );
    expect(out.stats.refundDrift).toBe(0);
    expect(out.stats.matched).toBe(1);
  });

  it("ignores paykit txns with null providerRef (e.g. abandoned checkout)", () => {
    const out = diffPaykitVsProvider("stripe", [pk("tx-1", null, "1000000", "pending")], []);
    expect(out.stats.providerMissing).toBe(0);
  });

  it("idempotent: running same input twice produces same stats", () => {
    const inputPk = [pk("tx-1", "cs_1", "1000000", "completed")];
    const inputProv = [prov("cs_1", "1000000")];
    const a = diffPaykitVsProvider("stripe", inputPk, inputProv);
    const b = diffPaykitVsProvider("stripe", inputPk, inputProv);
    expect(a.stats).toEqual(b.stats);
  });

  it("reports a differing currency as its own finding, not as an amount drift", () => {
    // 9.95 of some coin against a 9.95 USD row is an adapter that never
    // normalized. Calling it amount_mismatch would imply a settlement shortfall
    // whose size means nothing, and here the integers happen to agree — so the
    // amount check alone would call this a clean match.
    const out = diffPaykitVsProvider(
      "nowpayments",
      [pk("tx-1", "tx-1", "9950000", "completed", "USD")],
      [{ providerRef: "tx-1", amountMicros: "9950000", currencyCode: "USDT" }],
    );
    expect(out.stats.currencyMismatch).toBe(1);
    expect(out.stats.matched).toBe(0);
    expect(out.stats.amountMismatch).toBe(0);
    expect(out.discrepancies[0]?.type).toBe("currency_mismatch");
    expect(out.discrepancies[0]?.paykitCurrencyCode).toBe("USD");
    expect(out.discrepancies[0]?.providerCurrencyCode).toBe("USDT");
  });

  it("treats currency codes case-insensitively, since provider JSON varies", () => {
    const out = diffPaykitVsProvider(
      "nowpayments",
      [pk("tx-1", "tx-1", "1000000", "completed", "USD")],
      [{ providerRef: "tx-1", amountMicros: "1000000", currencyCode: "usd" }],
    );
    expect(out.stats.matched).toBe(1);
    expect(out.stats.currencyMismatch).toBe(0);
  });
});
