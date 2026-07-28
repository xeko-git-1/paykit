/**
 * Unit tests for the settlement amount guard.
 *
 * The guard is the only thing standing between a memo-matched bank transfer
 * and a full-amount ledger credit, so each branch is pinned here in isolation
 * (the router e2e test covers the wiring).
 */
import { describe, expect, it } from "vitest";

import { evaluateSettlementAmount } from "../src/routes/webhooks/settlement-amount-guard.js";

const REQUESTED = "500000000000.000000"; // 500_000 VND in micros, numeric(20,6) shape

describe("evaluateSettlementAmount", () => {
  it("skips the comparison for providers that settle the exact requested amount", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: true,
      requestedMicros: REQUESTED,
      receivedMicros: "10000000000", // way short, but provider is exact-settle
    });
    expect(outcome).toEqual({ decision: "credit", creditMicros: "10000000000" });
  });

  it("credits the received amount when it matches the requested amount", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: REQUESTED,
      receivedMicros: "500000000000",
    });
    expect(outcome).toEqual({ decision: "credit", creditMicros: "500000000000" });
  });

  it("rejects an underpaid transfer instead of crediting it", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: REQUESTED,
      receivedMicros: "10000000000", // 10_000 VND against a 500_000 VND charge
    });
    expect(outcome).toEqual({
      decision: "underpaid",
      requestedMicros: "500000000000",
      receivedMicros: "10000000000",
      shortfallMicros: "490000000000",
    });
  });

  it("treats a one-micro shortfall as underpaid (exact match, no tolerance band)", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: REQUESTED,
      receivedMicros: "499999999999",
    });
    expect(outcome).toMatchObject({ decision: "underpaid", shortfallMicros: "1" });
  });

  it("credits only the requested amount on overpayment and reports the overage", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: REQUESTED,
      receivedMicros: "600000000000", // 600_000 VND against a 500_000 VND charge
    });
    expect(outcome).toEqual({
      decision: "overpaid",
      creditMicros: "500000000000",
      requestedMicros: "500000000000",
      receivedMicros: "600000000000",
      overageMicros: "100000000000",
    });
  });

  it("parses the numeric(20,6) fractional form without throwing", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: "500000000000.000000",
      receivedMicros: "500000000000.000000",
    });
    expect(outcome).toEqual({ decision: "credit", creditMicros: "500000000000.000000" });
  });

  it("refuses to credit when the requested amount is unreadable", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: "not-a-number",
      receivedMicros: "500000000000",
    });
    expect(outcome).toEqual({ decision: "unreadable_amount", reason: "requested" });
  });

  it("refuses to credit when the received amount is unreadable", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: REQUESTED,
      receivedMicros: "12,000",
    });
    expect(outcome).toEqual({ decision: "unreadable_amount", reason: "received" });
  });

  it("refuses to credit a non-positive requested amount", () => {
    const outcome = evaluateSettlementAmount({
      settlesExactAmount: false,
      requestedMicros: "0",
      receivedMicros: "500000000000",
    });
    expect(outcome).toEqual({ decision: "unreadable_amount", reason: "requested" });
  });
});
