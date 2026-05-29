import { describe, expect, it } from "vitest";
import { getHandledEventTypes, isHandledEventType, mapEvent } from "../src/webhook-events.js";

function fakeEvent(type: string, dataObject: Record<string, unknown>, created = 1_700_000_000): {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
} {
  return { id: `evt_${type}`, type, created, data: { object: dataObject } };
}

describe("Stripe webhook events — handled list (RT F1, Val S4 Q1)", () => {
  it("registers exactly 10 handled Stripe types", () => {
    expect(getHandledEventTypes()).toHaveLength(10);
  });

  it("isHandledEventType returns true for all 10", () => {
    const expected = [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.funds_withdrawn",
      "credit_note.created",
      "customer.deleted",
    ];
    for (const t of expected) {
      expect(isHandledEventType(t)).toBe(true);
    }
  });

  it("returns false for unrelated Stripe events", () => {
    expect(isHandledEventType("payment_intent.succeeded")).toBe(false);
    expect(isHandledEventType("checkout.session.completed")).toBe(false);
  });
});

describe("mapEvent — 5 sub/invoice events", () => {
  it("customer.subscription.created → sub.created with status", () => {
    const ev = fakeEvent("customer.subscription.created", {
      id: "sub_123",
      customer: "cus_abc",
      status: "active",
      cancel_at_period_end: false,
      items: { data: [{ id: "si_1", price: { id: "price_p1" }, current_period_end: 1_700_010_000 }] },
      currency: "usd",
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("sub.created");
    expect(r?.subscriptionId).toBe("sub_123");
    expect(r?.customerId).toBe("cus_abc");
    expect(r?.status).toBe("active");
    expect(r?.eventCreatedAt.getTime()).toBe(1_700_000_000_000);
  });

  it("customer.subscription.deleted → sub.deleted", () => {
    const ev = fakeEvent("customer.subscription.deleted", {
      id: "sub_999",
      customer: "cus_abc",
      status: "canceled",
      cancel_at_period_end: true,
      items: { data: [{ price: { id: "price_p1" } }] },
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("sub.deleted");
    expect(r?.status).toBe("canceled");
  });

  it("invoice.paid → invoice.paid with amountMicros + invoiceId", () => {
    const ev = fakeEvent("invoice.paid", {
      id: "in_1",
      customer: "cus_abc",
      subscription: "sub_123",
      amount_paid: 1500,
      currency: "usd",
      number: "INV-001",
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("invoice.paid");
    expect(r?.subscriptionId).toBe("sub_123");
    expect(r?.amountMicros).toBe("15000000");
    expect(r?.invoiceId).toBe("in_1");
    expect(r?.currencyCode).toBe("USD");
  });

  it("invoice.payment_failed → invoice.failed", () => {
    const ev = fakeEvent("invoice.payment_failed", {
      id: "in_2",
      customer: "cus_abc",
      subscription: "sub_123",
      amount_due: 2000,
      currency: "usd",
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("invoice.failed");
    expect(r?.amountMicros).toBe("20000000");
  });
});

describe("mapEvent — 4 refund/dispute events", () => {
  it("charge.refunded → charge.refunded with refundAmountMicros", () => {
    const ev = fakeEvent("charge.refunded", {
      id: "ch_1",
      customer: "cus_abc",
      currency: "usd",
      amount_refunded: 500,
      metadata: { paykit_subscription_id: "sub_123" },
      refunds: { data: [{ id: "re_1" }] },
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("charge.refunded");
    expect(r?.subscriptionId).toBe("sub_123");
    expect(r?.refundAmountMicros).toBe("5000000");
    expect(r?.chargeId).toBe("ch_1");
  });

  it("charge.dispute.created → charge.dispute.created", () => {
    const ev = fakeEvent("charge.dispute.created", {
      id: "dp_1",
      customer: "cus_abc",
      charge: "ch_1",
      amount: 1000,
      currency: "usd",
      reason: "fraudulent",
      metadata: { paykit_subscription_id: "sub_123" },
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("charge.dispute.created");
    expect(r?.amountMicros).toBe("10000000");
  });

  it("charge.dispute.funds_withdrawn → charge.dispute.funds_withdrawn", () => {
    const ev = fakeEvent("charge.dispute.funds_withdrawn", {
      id: "dp_1",
      customer: "cus_abc",
      charge: { id: "ch_1" },
      amount: 1000,
      currency: "usd",
      metadata: { paykit_subscription_id: "sub_123" },
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("charge.dispute.funds_withdrawn");
    expect(r?.chargeId).toBe("ch_1");
  });

  it("credit_note.created → credit_note.created", () => {
    const ev = fakeEvent("credit_note.created", {
      id: "cn_1",
      customer: "cus_abc",
      amount: 250,
      currency: "usd",
      reason: "duplicate",
      metadata: { paykit_subscription_id: "sub_123" },
    });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("credit_note.created");
    expect(r?.refundAmountMicros).toBe("2500000");
  });
});

describe("mapEvent — customer.deleted (Val S4 Q1)", () => {
  it("emits customer.deleted with empty subscriptionId — handler cascades by customer", () => {
    const ev = fakeEvent("customer.deleted", { id: "cus_abc" });
    const r = mapEvent(ev as never);
    expect(r?.type).toBe("customer.deleted");
    expect(r?.subscriptionId).toBe("");
    expect(r?.customerId).toBe("cus_abc");
  });
});

describe("mapEvent — unrelated Stripe types", () => {
  it("returns null for non-handled types so the dispatcher can ACK + skip", () => {
    const ev = fakeEvent("payment_intent.succeeded", { id: "pi_1" });
    const r = mapEvent(ev as never);
    expect(r).toBeNull();
  });
});
