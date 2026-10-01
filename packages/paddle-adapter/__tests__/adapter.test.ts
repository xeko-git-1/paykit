/**
 * Paddle adapter tests — against a local mock of api.paddle.com.
 *
 * Covers:
 *   - createCheckout: inline (non-catalog) price body, custom_data reference,
 *     providerSessionId = Paddle transaction id, zero-decimal JPY amounts,
 *     unsupported currency rejection, missing-checkout-url failure
 *   - Paddle-Signature verification: valid, wrong secret, stale ts, rotation
 *   - parseWebhookPayload: transaction.completed → payment.completed;
 *     approved refund adjustment → payment.refunded; pending_approval
 *     skipped; payment_failed/canceled → payment.failed
 *   - refund: full vs partial adjustment bodies, pending_approval →
 *     pending_webhook, missing providerRef → failed, HTTP error → failed
 *   - fetchTransactions: billed_at server-side filter params, pagination via
 *     meta.pagination.next, HTTP error throws
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PAYKIT_REFERENCE_CUSTOM_DATA_KEY, createPaddleAdapter } from "../src/adapter.js";

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function mockFetch(
  responder: (input: { url: string; init?: RequestInit }) => { status: number; body: string },
): { fetcher: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push(body !== undefined ? { url, method, body } : { url, method });
    const result = responder({ url, init });
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const SECRET = "pdl_ntfset_test_secret";

function makeAdapter(fetcher: typeof fetch, opts?: { webhookSecret?: string | string[] }) {
  return createPaddleAdapter({
    apiKey: "pdl_sdbx_apikey_test",
    webhookSecret: opts?.webhookSecret ?? SECRET,
    sandbox: true,
    fetcher,
  });
}

function signedHeaders(
  body: string,
  secret: string = SECRET,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const h1 = createHmac("sha256", secret).update(`${timestampSeconds}:${body}`).digest("hex");
  return { "Paddle-Signature": `ts=${timestampSeconds};h1=${h1}` };
}

/** A transaction body as GET /transactions/{id} would return it. */
function paddleTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn_1",
    status: "completed",
    currency_code: "USD",
    custom_data: { [PAYKIT_REFERENCE_CUSTOM_DATA_KEY]: "tx-1" },
    details: {
      totals: { total: "1999", grand_total: "1999", currency_code: "USD" },
      line_items: [{ id: "txnitm_1" }],
    },
    ...overrides,
  };
}

describe("createCheckout", () => {
  it("creates a transaction with an inline price and returns the txn id as providerSessionId", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 201,
      body: JSON.stringify({
        data: {
          id: "txn_1",
          checkout: { url: "https://pay.example.com/checkout?_ptxn=txn_1" },
        },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.createCheckout({
      transactionId: "tx-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 19_990_000n, // USD 19.99
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://pay.example.com/checkout?_ptxn=txn_1");
    // provider_ref = txn_... — the id every transaction webhook carries as
    // data.id, and the key the refund/listing APIs use.
    expect(result.providerSessionId).toBe("txn_1");

    expect(calls[0]?.url).toBe("https://sandbox-api.paddle.com/transactions");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.items[0].price.unit_price).toEqual({ amount: "1999", currency_code: "USD" });
    expect(body.items[0].price.product.tax_category).toBe("standard");
    expect(body.custom_data[PAYKIT_REFERENCE_CUSTOM_DATA_KEY]).toBe("tx-1");
  });

  it("sends zero-decimal JPY amounts in whole yen, not a ×100 fabrication", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 201,
      body: JSON.stringify({
        data: { id: "txn_jp", checkout: { url: "https://pay.example.com/c?_ptxn=txn_jp" } },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    await adapter.createCheckout({
      transactionId: "tx-jp",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000_000n, // JPY 1000
      currencyCode: "JPY",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.items[0].price.unit_price.amount).toBe("1000");
    expect(body.items[0].price.unit_price.currency_code).toBe("JPY");
  });

  it("rejects currencies the adapter does not declare", async () => {
    const { fetcher } = mockFetch(() => ({ status: 201, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-2",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD\/EUR\/JPY/);
  });

  it("fails loudly when Paddle returns no checkout url (default payment link unset)", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 201,
      body: JSON.stringify({ data: { id: "txn_1", checkout: { url: null } } }),
    }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-1",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/default payment link/);
  });
});

describe("verifyWebhookSignature (Paddle-Signature)", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);
  const body = JSON.stringify({ event_type: "transaction.completed", data: {} });

  it("accepts a correctly signed delivery", () => {
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body, "wrong"))).toBe(false);
  });

  it("rejects a stale timestamp even with a valid signature", () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body, SECRET, stale))).toBe(false);
  });

  it("accepts the old secret during rotation", () => {
    const rotated = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher, {
      webhookSecret: ["pdl_ntfset_new", SECRET],
    });
    expect(rotated.verifyWebhookSignature(body, signedHeaders(body))).toBe(true);
  });

  it("rejects when the header is missing", () => {
    expect(adapter.verifyWebhookSignature(body, {})).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);

  it("maps transaction.completed to payment.completed keyed on the Paddle txn id", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        event_id: "evt_1",
        event_type: "transaction.completed",
        data: paddleTxn(),
      }),
      {},
    );
    expect(evt).not.toBeNull();
    expect(evt?.eventId).toBe("evt_1");
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("txn_1");
    expect(evt?.amountMicros).toBe("19990000");
    expect(evt?.currencyCode).toBe("USD");
  });

  it("converts zero-decimal JPY totals without a ×100 fabrication", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        event_id: "evt_jp",
        event_type: "transaction.completed",
        data: paddleTxn({
          id: "txn_jp",
          currency_code: "JPY",
          details: { totals: { grand_total: "1000", currency_code: "JPY" } },
        }),
      }),
      {},
    );
    // JPY 1000 = 1000 × 1_000_000 micros.
    expect(evt?.amountMicros).toBe("1000000000");
    expect(evt?.currencyCode).toBe("JPY");
  });

  it("maps an APPROVED refund adjustment to payment.refunded", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        event_id: "evt_2",
        event_type: "adjustment.updated",
        data: {
          id: "adj_1",
          action: "refund",
          status: "approved",
          transaction_id: "txn_1",
          totals: { total: "500", currency_code: "USD" },
        },
      }),
      {},
    );
    expect(evt?.type).toBe("payment.refunded");
    expect(evt?.providerRef).toBe("txn_1");
    expect(evt?.refundAmountMicros).toBe("5000000");
    expect(evt?.providerRefundId).toBe("adj_1");
  });

  it("skips pending_approval adjustments (only approved moves money)", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        event_id: "evt_3",
        event_type: "adjustment.created",
        data: {
          id: "adj_1",
          action: "refund",
          status: "pending_approval",
          transaction_id: "txn_1",
          totals: { total: "500", currency_code: "USD" },
        },
      }),
      {},
    );
    expect(evt).toBeNull();
  });

  it("maps transaction.payment_failed to payment.failed", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        event_id: "evt_4",
        event_type: "transaction.payment_failed",
        data: { id: "txn_1" },
      }),
      {},
    );
    expect(evt?.type).toBe("payment.failed");
    expect(evt?.providerRef).toBe("txn_1");
  });

  it("returns null for unparseable bodies and unknown event types", () => {
    expect(adapter.parseWebhookPayload("not json", {})).toBeNull();
    expect(
      adapter.parseWebhookPayload(
        JSON.stringify({ event_type: "subscription.created", data: {} }),
        {},
      ),
    ).toBeNull();
  });
});

describe("refund", () => {
  it("issues a FULL adjustment when the amount equals the transaction's grand total", async () => {
    const { fetcher, calls } = mockFetch(({ url }) => {
      if (url.endsWith("/transactions/txn_1")) {
        return { status: 200, body: JSON.stringify({ data: paddleTxn() }) };
      }
      return {
        status: 201,
        body: JSON.stringify({ data: { id: "adj_1", status: "pending_approval" } }),
      };
    });
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 19_990_000n,
      idempotencyKey: "idem-1",
      reason: "customer request",
      providerRef: "txn_1",
    });

    // pending_approval is the documented response: Paddle approves refunds
    // out-of-band as merchant of record.
    expect(result.state).toBe("pending_webhook");
    expect(result.providerRefundId).toBe("adj_1");
    const adjBody = JSON.parse(calls[1]?.body ?? "{}");
    expect(adjBody.type).toBe("full");
    expect(adjBody.transaction_id).toBe("txn_1");
    expect(adjBody.items).toBeUndefined();
  });

  it("issues a PARTIAL adjustment naming the line item for a lesser amount", async () => {
    const { fetcher, calls } = mockFetch(({ url }) => {
      if (url.endsWith("/transactions/txn_1")) {
        return { status: 200, body: JSON.stringify({ data: paddleTxn() }) };
      }
      return {
        status: 201,
        body: JSON.stringify({ data: { id: "adj_2", status: "pending_approval" } }),
      };
    });
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 5_000_000n, // USD 5.00 of a 19.99 charge
      idempotencyKey: "idem-2",
      reason: "customer request",
      providerRef: "txn_1",
    });

    expect(result.state).toBe("pending_webhook");
    const adjBody = JSON.parse(calls[1]?.body ?? "{}");
    expect(adjBody.type).toBe("partial");
    expect(adjBody.items).toEqual([{ item_id: "txnitm_1", type: "partial", amount: "500" }]);
  });

  it("fails without a Paddle transaction id", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 5_000_000n,
      idempotencyKey: "idem-3",
      reason: "customer request",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_TRANSACTION_ID");
    expect(calls.length).toBe(0);
  });

  it("fails with the provider detail when the adjustment is rejected", async () => {
    const { fetcher } = mockFetch(({ url }) => {
      if (url.endsWith("/transactions/txn_1")) {
        return { status: 200, body: JSON.stringify({ data: paddleTxn() }) };
      }
      return {
        status: 400,
        body: JSON.stringify({ error: { code: "adjustment_invalid", detail: "too late" } }),
      };
    });
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 19_990_000n,
      idempotencyKey: "idem-4",
      reason: "customer request",
      providerRef: "txn_1",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("HTTP_400");
    expect(result.error?.message).toContain("too late");
  });
});

describe("fetchTransactions", () => {
  const window = {
    since: new Date("2026-08-05T00:00:00Z"),
    until: new Date("2026-08-12T00:00:00Z"),
  };

  it("asks Paddle for the window server-side and follows pagination to the end", async () => {
    const { fetcher, calls } = mockFetch(({ url }) => {
      if (url.includes("after=cursor2")) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [paddleTxn({ id: "txn_2", details: { totals: { grand_total: "500" } } })],
            meta: { pagination: { has_more: false } },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          data: [paddleTxn()],
          meta: {
            pagination: {
              has_more: true,
              next: "https://sandbox-api.paddle.com/transactions?after=cursor2",
            },
          },
        }),
      };
    });
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions(window);

    expect(records).toEqual([
      { providerRef: "txn_1", amountMicros: "19990000", currencyCode: "USD" },
      { providerRef: "txn_2", amountMicros: "5000000", currencyCode: "USD" },
    ]);

    const firstUrl = new URL(calls[0]?.url ?? "");
    expect(firstUrl.searchParams.get("status")).toBe("completed");
    expect(firstUrl.searchParams.get("billed_at[GTE]")).toBe("2026-08-05T00:00:00.000Z");
    expect(firstUrl.searchParams.get("billed_at[LT]")).toBe("2026-08-12T00:00:00.000Z");
  });

  it("throws on HTTP failure instead of returning a misleading empty list", async () => {
    const { fetcher } = mockFetch(() => ({ status: 500, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(adapter.fetchTransactions(window)).rejects.toThrow(/HTTP 500/);
  });
});
