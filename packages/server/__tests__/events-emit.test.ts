import { describe, expect, it, vi } from "vitest";
import type { PaymentTransaction } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";
import { type PaykitEventHandlers, emitEvent } from "../src/events/emitter.js";

const FAKE_TX: PaymentTransaction = {
  transactionId: "tx-1",
  tenantId: "t-1",
  ownerId: "o-1",
  provider: "stripe",
  amountMicros: "1000000",
  currencyCode: "USD",
  status: "completed",
  providerRef: "cs_x",
  idempotencyKey: null,
  metadataJson: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("emitEvent (post-transaction lifecycle hooks)", () => {
  it("calls onPaymentCompleted exactly once", async () => {
    const onPaymentCompleted = vi.fn();
    const handlers: PaykitEventHandlers = { onPaymentCompleted };
    await emitEvent(handlers, { type: "payment.completed", transaction: FAKE_TX });
    expect(onPaymentCompleted).toHaveBeenCalledOnce();
    expect(onPaymentCompleted).toHaveBeenCalledWith(FAKE_TX);
  });

  it("calls onPaymentRefunded with refund amount string", async () => {
    const onPaymentRefunded = vi.fn();
    await emitEvent(
      { onPaymentRefunded },
      { type: "payment.refunded", transaction: FAKE_TX, refundAmountMicros: "500000" },
    );
    expect(onPaymentRefunded).toHaveBeenCalledWith(FAKE_TX, "500000");
  });

  it("calls onPaymentExpired", async () => {
    const onPaymentExpired = vi.fn();
    await emitEvent({ onPaymentExpired }, { type: "payment.expired", transaction: FAKE_TX });
    expect(onPaymentExpired).toHaveBeenCalledWith(FAKE_TX);
  });

  it("does not throw + logs warn when handler throws (decoupled from DB tx)", async () => {
    const warn = vi.fn();
    const onPaymentCompleted = vi.fn(() => {
      throw new Error("downstream API down");
    });
    await expect(
      emitEvent(
        { onPaymentCompleted },
        { type: "payment.completed", transaction: FAKE_TX },
        {
          warn,
        },
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/event handler threw/);
  });

  it("no-op when handler is undefined for the event type", async () => {
    await expect(
      emitEvent({}, { type: "payment.completed", transaction: FAKE_TX }),
    ).resolves.toBeUndefined();
  });

  it("awaits async handler", async () => {
    let resolved = false;
    const onPaymentCompleted = async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    };
    await emitEvent({ onPaymentCompleted }, { type: "payment.completed", transaction: FAKE_TX });
    expect(resolved).toBe(true);
  });
});
