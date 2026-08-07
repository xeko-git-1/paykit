/**
 * Stripe refund events: per-refund delta, per-refund identity, and settled-only.
 *
 * The defect these cover is a silent money loss. `Charge.amount_refunded` is a
 * running total across every refund of the charge, so reading it as one refund's
 * amount reports the SUM once a second partial refund lands. Combined with an
 * event that carried no refund id — leaving the ledger keyed on the payment
 * reference, which is unique per (provider, source_id, entry_type) — the second
 * partial refund collided with the first, its balance move was skipped, and the
 * caller still saw success.
 *
 * So two things are asserted together throughout: the amount is this refund's own
 * amount, and the event names this refund. Either one alone still loses money.
 */
import { describe, expect, it, vi } from "vitest";

/**
 * Session-create arguments, recorded outside the mock class.
 *
 * The adapter constructs its own Stripe instance, so a test cannot reach the mock
 * instance the adapter is holding. Recording into a shared array sidesteps that
 * entirely: whichever instance was called, the arguments land here.
 */
const sessionCreateCalls = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: vi.fn(async (opts: Record<string, unknown>) => {
          sessionCreateCalls.push(opts);
          return {
            id: "cs_test_abc",
            url: "https://checkout.stripe.com/c/pay/cs_test_abc",
            metadata: opts.metadata,
          };
        }),
        retrieve: vi.fn(),
        list: vi.fn(),
      },
    };
    refunds = { create: vi.fn() };
    webhooks = {
      constructEvent: vi.fn((payload: string, sig: string, secret: string) => {
        if (sig === `sig_${secret}`) return JSON.parse(payload);
        throw new Error("invalid signature");
      }),
    };
  }
  return { default: MockStripe };
});

import { createStripeAdapter } from "../src/adapter.js";

const config = {
  secretKey: "sk_test_x",
  webhookSecret: "whsec_v1",
  successUrl: "https://app.example/billing/success",
  cancelUrl: "https://app.example/billing/checkout",
};

const SIG = { "stripe-signature": "sig_whsec_v1" };
const TX_ID = "a0000000-0000-4000-8000-000000000001";

function parse(adapter: ReturnType<typeof createStripeAdapter>, event: unknown) {
  return adapter.parseWebhookPayload(JSON.stringify(event), SIG);
}

/** A settled Refund of `cents`, stamped as paykit's if `sessionId` is given. */
function refundEvent(opts: {
  eventId: string;
  refundId: string;
  cents: number;
  status?: string;
  sessionId?: string;
  chargeId?: string;
}) {
  const metadata: Record<string, string> = {};
  if (opts.sessionId !== undefined) {
    metadata.checkoutSessionId = opts.sessionId;
    metadata.paykitTransactionId = TX_ID;
  }
  return {
    id: opts.eventId,
    type: "refund.created",
    data: {
      object: {
        id: opts.refundId,
        object: "refund",
        amount: opts.cents,
        currency: "usd",
        status: opts.status ?? "succeeded",
        charge: opts.chargeId ?? "ch_1",
        metadata,
      },
    },
  };
}

describe("a refund event carries THIS refund's amount, not the charge total", () => {
  const adapter = createStripeAdapter(config);

  it("reports each partial refund's own amount", () => {
    const first = parse(
      adapter,
      refundEvent({ eventId: "evt_r1", refundId: "re_1", cents: 300, sessionId: "cs_orig" }),
    );
    const second = parse(
      adapter,
      refundEvent({ eventId: "evt_r2", refundId: "re_2", cents: 700, sessionId: "cs_orig" }),
    );

    // $3.00 and $7.00 — not $3.00 then $10.00, which is what the cumulative
    // charge total would have reported for the second one.
    expect(first?.refundAmountMicros).toBe("3000000");
    expect(second?.refundAmountMicros).toBe("7000000");
  });

  it("gives each refund a distinct identity, so neither dedups the other away", () => {
    const first = parse(
      adapter,
      refundEvent({ eventId: "evt_r1", refundId: "re_1", cents: 300, sessionId: "cs_orig" }),
    );
    const second = parse(
      adapter,
      refundEvent({ eventId: "evt_r2", refundId: "re_2", cents: 700, sessionId: "cs_orig" }),
    );

    expect(first?.providerRefundId).toBe("re_1");
    expect(second?.providerRefundId).toBe("re_2");
    expect(first?.providerRefundId).not.toBe(second?.providerRefundId);
  });

  it("keeps both refunds pointing at the same payment", () => {
    const first = parse(
      adapter,
      refundEvent({ eventId: "evt_r1", refundId: "re_1", cents: 300, sessionId: "cs_orig" }),
    );
    const second = parse(
      adapter,
      refundEvent({ eventId: "evt_r2", refundId: "re_2", cents: 700, sessionId: "cs_orig" }),
    );
    expect(first?.providerRef).toBe("cs_orig");
    expect(second?.providerRef).toBe("cs_orig");
  });

  it("redelivery of one refund keeps its identity, so the server can collapse it", () => {
    const once = parse(
      adapter,
      refundEvent({ eventId: "evt_r1", refundId: "re_1", cents: 300, sessionId: "cs_orig" }),
    );
    const again = parse(
      adapter,
      refundEvent({ eventId: "evt_r1", refundId: "re_1", cents: 300, sessionId: "cs_orig" }),
    );
    expect(again?.providerRefundId).toBe(once?.providerRefundId);
    expect(again?.refundAmountMicros).toBe(once?.refundAmountMicros);
  });
});

describe("only a settled refund moves money", () => {
  const adapter = createStripeAdapter(config);

  for (const status of ["pending", "requires_action", "failed", "canceled"]) {
    it(`ignores a refund in '${status}'`, () => {
      const result = parse(
        adapter,
        refundEvent({
          eventId: `evt_${status}`,
          refundId: "re_x",
          cents: 500,
          status,
          sessionId: "cs_orig",
        }),
      );
      // A created-pending refund can still fail. Crediting on creation would give
      // money back for a refund that never happened.
      expect(result).toBeNull();
    });
  }

  it("processes the same refund once it succeeds", () => {
    const result = parse(
      adapter,
      refundEvent({
        eventId: "evt_ok",
        refundId: "re_x",
        cents: 500,
        status: "succeeded",
        sessionId: "cs_orig",
      }),
    );
    expect(result?.type).toBe("payment.refunded");
    expect(result?.refundAmountMicros).toBe("5000000");
  });

  it("handles refund.updated and refund.failed the same way", () => {
    const updated = parse(adapter, {
      ...refundEvent({ eventId: "evt_u", refundId: "re_u", cents: 250, sessionId: "cs_orig" }),
      type: "refund.updated",
    });
    expect(updated?.refundAmountMicros).toBe("2500000");

    const failed = parse(adapter, {
      ...refundEvent({
        eventId: "evt_f",
        refundId: "re_f",
        cents: 250,
        status: "failed",
        sessionId: "cs_orig",
      }),
      type: "refund.failed",
    });
    expect(failed).toBeNull();
  });
});

describe("a Dashboard-initiated refund is still attributable", () => {
  const adapter = createStripeAdapter(config);

  it("carries the paykit transaction id when the charge was stamped", () => {
    // A refund created in the Stripe Dashboard inherits no metadata of its own,
    // so the stamp has to be read from the charge it points at.
    const result = parse(adapter, {
      id: "evt_dash",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_dash",
          amount_refunded: 400,
          currency: "usd",
          metadata: { paykitTransactionId: TX_ID, checkoutSessionId: "cs_orig" },
          refunds: { data: [{ id: "re_dash", amount: 400 }] },
        },
      },
    });
    expect(result?.providerRef).toBe("cs_orig");
    expect(result?.metadata.paykitTransactionId).toBe(TX_ID);
    expect(result?.providerRefundId).toBe("re_dash");
  });

  it("falls back to a Stripe-side reference when nothing was stamped", () => {
    const result = parse(
      adapter,
      refundEvent({
        eventId: "evt_old",
        refundId: "re_old",
        cents: 400,
        chargeId: "ch_old",
      }),
    );
    // Deliberately not a session id: it will not match a stored provider_ref, so
    // the server sees an unmatched refund rather than debiting the wrong payment.
    expect(result?.providerRef).toBe("ch_old");
    expect(result?.providerRefundId).toBe("re_old");
  });
});

describe("charge.refunded remains usable for a single refund", () => {
  const adapter = createStripeAdapter(config);

  it("uses the Refund object's amount when one is present", () => {
    // The charge total and this refund's amount differ here; the per-refund
    // amount is the correct delta.
    const result = parse(adapter, {
      id: "evt_c1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          amount_refunded: 1000,
          currency: "usd",
          metadata: { checkoutSessionId: "cs_orig" },
          refunds: { data: [{ id: "re_latest", amount: 700 }] },
        },
      },
    });
    expect(result?.refundAmountMicros).toBe("7000000");
    expect(result?.providerRefundId).toBe("re_latest");
  });

  it("falls back to the charge total when no Refund object is expanded", () => {
    const result = parse(adapter, {
      id: "evt_c2",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_2",
          amount_refunded: 500,
          currency: "usd",
          metadata: { checkoutSessionId: "cs_orig" },
        },
      },
    });
    // Equal to the delta while there has only been one refund. No refund id is
    // available, which the server reads as "at most one refund for this payment".
    expect(result?.refundAmountMicros).toBe("5000000");
    expect(result?.providerRefundId).toBeUndefined();
  });
});

describe("createCheckout plants the link a refund event needs", () => {
  it("stamps paykit ids on the PaymentIntent as well as the Session", async () => {
    const adapter = createStripeAdapter(config);
    await adapter.createCheckout({
      transactionId: TX_ID,
      tenantId: "b0000000-0000-4000-8000-000000000002",
      ownerId: "c0000000-0000-4000-8000-000000000003",
      amountMicros: 10_000_000n,
      currencyCode: "USD",
    });

    const sent = sessionCreateCalls.at(-1);

    expect(sent?.metadata).toMatchObject({ paykitTransactionId: TX_ID });
    // Session metadata does NOT propagate to the Charge, and a Refund points at a
    // Charge — never at the Session. Without this second stamp there is no path
    // from a refund event back to the paykit transaction.
    expect(sent?.payment_intent_data).toMatchObject({
      metadata: { paykitTransactionId: TX_ID },
    });
  });
});
