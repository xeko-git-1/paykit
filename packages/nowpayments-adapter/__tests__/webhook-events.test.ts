/**
 * NowPayments IPN status → paykit WebhookEventType mapping tests
 * (Phase 03 tests #9-15).
 */
import { describe, expect, it } from "vitest";
import { mapStatusToEventType, parseNpIpn } from "../src/webhook-events.js";

describe("webhook-events status mapping", () => {
  it("maps 'finished' → payment.completed", () => {
    expect(mapStatusToEventType("finished")).toBe("payment.completed");
  });

  it("maps 'failed' → payment.failed", () => {
    expect(mapStatusToEventType("failed")).toBe("payment.failed");
  });

  it("maps 'expired' → payment.expired", () => {
    expect(mapStatusToEventType("expired")).toBe("payment.expired");
  });

  it("maps 'refunded' → payment.refunded", () => {
    expect(mapStatusToEventType("refunded")).toBe("payment.refunded");
  });

  it("maps 'partially_paid' → payment.underpaid (RT F5)", () => {
    expect(mapStatusToEventType("partially_paid")).toBe("payment.underpaid");
  });

  it("maps in-flight statuses (waiting/confirming/confirmed/sending) → null", () => {
    expect(mapStatusToEventType("waiting")).toBeNull();
    expect(mapStatusToEventType("confirming")).toBeNull();
    expect(mapStatusToEventType("confirmed")).toBeNull();
    expect(mapStatusToEventType("sending")).toBeNull();
  });

  it("maps unknown statuses → null", () => {
    expect(mapStatusToEventType("zzz")).toBeNull();
    expect(mapStatusToEventType(undefined)).toBeNull();
  });
});

describe("parseNpIpn — payment.completed (full flow)", () => {
  it("emits payment.completed with full metadata for a finished payment", () => {
    const evt = parseNpIpn({
      payment_id: 5524759814,
      payment_status: "finished",
      order_id: "tx-uuid-1",
      price_amount: 50,
      price_currency: "usd",
      actually_paid: 50,
      pay_currency: "usdcmatic",
    });
    expect(evt).not.toBeNull();
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("tx-uuid-1");
    expect(evt?.amountMicros).toBe("50000000");
    expect(evt?.expectedAmountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
    expect(evt?.eventId).toContain("nowpayments:tx-uuid-1");
  });
});

describe("parseNpIpn — payment.underpaid", () => {
  it("emits payment.underpaid with actual+expected amount micros for partially_paid", () => {
    const evt = parseNpIpn({
      payment_id: 1,
      payment_status: "partially_paid",
      order_id: "tx-up",
      price_amount: 50,
      price_currency: "usd",
      actually_paid: 47.21,
      pay_currency: "btc",
    });
    expect(evt?.type).toBe("payment.underpaid");
    expect(evt?.expectedAmountMicros).toBe("50000000");
    expect(evt?.amountMicros).toBe("47210000");
  });
});

describe("parseNpIpn — in-flight skip", () => {
  it("returns null for confirming (skip — wait for finished)", () => {
    const evt = parseNpIpn({
      payment_id: 1,
      payment_status: "confirming",
      order_id: "tx-cf",
      price_amount: 50,
    });
    expect(evt).toBeNull();
  });

  it("returns null when order_id is missing", () => {
    const evt = parseNpIpn({
      payment_id: 1,
      payment_status: "finished",
    });
    expect(evt).toBeNull();
  });
});

describe("parseNpIpn — amount drift > 5 bps → payment.amount_mismatch (Val D3)", () => {
  it("flags >5 bps drift as payment.amount_mismatch instead of payment.completed", () => {
    const evt = parseNpIpn({
      payment_id: 1,
      payment_status: "finished",
      order_id: "tx-drift",
      price_amount: 50,
      price_currency: "usd",
      actually_paid: 49.95,
    });
    expect(evt?.type).toBe("payment.amount_mismatch");
  });

  it("does NOT flag drift within 5 bps", () => {
    const evt = parseNpIpn({
      payment_id: 1,
      payment_status: "finished",
      order_id: "tx-no-drift",
      price_amount: 50,
      price_currency: "usd",
      actually_paid: 49.99,
    });
    expect(evt?.type).toBe("payment.completed");
  });
});
