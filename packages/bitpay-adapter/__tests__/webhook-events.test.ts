/**
 * BitPay invoice status mapping + invoiceToEvent tests (pure, no fetch).
 */
import { describe, expect, it } from "vitest";
import { invoiceToEvent, mapInvoiceStatusToEventType } from "../src/webhook-events.js";

describe("mapInvoiceStatusToEventType", () => {
  it("maps confirmed + complete → payment.completed", () => {
    expect(mapInvoiceStatusToEventType("confirmed")).toBe("payment.completed");
    expect(mapInvoiceStatusToEventType("complete")).toBe("payment.completed");
  });

  it("maps expired → payment.expired", () => {
    expect(mapInvoiceStatusToEventType("expired")).toBe("payment.expired");
  });

  it("maps invalid → payment.failed", () => {
    expect(mapInvoiceStatusToEventType("invalid")).toBe("payment.failed");
  });

  it("maps in-flight (new/paid) → null", () => {
    expect(mapInvoiceStatusToEventType("new")).toBeNull();
    expect(mapInvoiceStatusToEventType("paid")).toBeNull();
  });

  it("maps unknown/undefined → null", () => {
    expect(mapInvoiceStatusToEventType("zzz")).toBeNull();
    expect(mapInvoiceStatusToEventType(undefined)).toBeNull();
  });
});

describe("invoiceToEvent", () => {
  it("returns null without an orderId (cannot map to a paykit tx)", () => {
    expect(invoiceToEvent({ id: "i", status: "complete", price: 10 })).toBeNull();
  });

  it("emits payment.completed with amounts for a settled invoice", () => {
    const evt = invoiceToEvent({
      id: "i1",
      orderId: "tx-1",
      status: "complete",
      price: 50,
      currency: "usd",
      amountPaid: 50,
    });
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("tx-1");
    expect(evt?.amountMicros).toBe("50000000");
    expect(evt?.expectedAmountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
  });

  it("flags > 5 bps amount drift as payment.amount_mismatch", () => {
    const evt = invoiceToEvent({
      id: "i2",
      orderId: "tx-2",
      status: "complete",
      price: 50,
      currency: "USD",
      amountPaid: 49.9,
    });
    expect(evt?.type).toBe("payment.amount_mismatch");
  });

  it("does NOT flag drift within 5 bps", () => {
    const evt = invoiceToEvent({
      id: "i3",
      orderId: "tx-3",
      status: "complete",
      price: 50,
      currency: "USD",
      amountPaid: 49.99,
    });
    expect(evt?.type).toBe("payment.completed");
  });

  it("paidPartial exceptionStatus → payment.underpaid (takes priority over drift)", () => {
    const evt = invoiceToEvent({
      id: "i4",
      orderId: "tx-4",
      status: "complete",
      exceptionStatus: "paidPartial",
      price: 50,
      currency: "USD",
      amountPaid: 30,
    });
    expect(evt?.type).toBe("payment.underpaid");
  });
});
