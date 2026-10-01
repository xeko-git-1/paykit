/**
 * Polar adapter tests — against a local mock of api.polar.sh.
 *
 * Covers:
 *   - createCheckout: product + ad-hoc fixed price body, metadata round-trip,
 *     providerSessionId omitted (provider_ref must stay = transactionId),
 *     unsupported currency rejection
 *   - Standard Webhooks signature: valid, wrong secret, stale timestamp,
 *     secret rotation
 *   - parseWebhookPayload: order.paid → payment.completed; refunds (succeeded
 *     only, dashboard refunds skipped); checkout.updated expired/failed;
 *     garbage skipped
 *   - refund: succeeded → completed; pending → pending_webhook; missing order
 *     id → failed; HTTP error → failed
 *   - fetchTransactions: window filtering, non-paykit orders skipped,
 *     newest-first early stop, HTTP error throws
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PAYKIT_REFERENCE_METADATA_KEY, createPolarAdapter } from "../src/adapter.js";

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

const SECRET = "polar-webhook-secret";

function makeAdapter(fetcher: typeof fetch, opts?: { webhookSecret?: string | string[] }) {
  return createPolarAdapter({
    accessToken: "polar_oat_test",
    productId: "prod_123",
    webhookSecret: opts?.webhookSecret ?? SECRET,
    sandbox: true,
    fetcher,
  });
}

/** Standard Webhooks headers for a body, signed with `secret`. */
function signedHeaders(
  body: string,
  secret: string = SECRET,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const id = "msg_test_1";
  const signature = createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(`${id}.${timestampSeconds}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": `v1,${signature}`,
  };
}

describe("createCheckout", () => {
  it("prices the session over the product with a fixed ad-hoc amount and carries the paykit reference", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 201,
      body: JSON.stringify({
        id: "co_1",
        url: "https://sandbox.polar.sh/checkout/co_1",
        expires_at: "2026-08-13T12:00:00Z",
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

    expect(result.webUrl).toBe("https://sandbox.polar.sh/checkout/co_1");
    expect(result.expiresAt.toISOString()).toBe("2026-08-13T12:00:00.000Z");
    // providerSessionId MUST be omitted: order webhooks carry the paykit
    // transaction id in metadata, not the checkout id, so provider_ref must
    // stay = transactionId for the webhook lookup to match.
    expect(result.providerSessionId).toBeUndefined();

    expect(calls[0]?.url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.products).toEqual(["prod_123"]);
    expect(body.prices.prod_123[0]).toEqual({
      amount_type: "fixed",
      price_amount: 1999,
      price_currency: "usd",
    });
    expect(body.metadata[PAYKIT_REFERENCE_METADATA_KEY]).toBe("tx-1");
  });

  it("rejects currencies Polar does not settle", async () => {
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
    ).rejects.toThrow(/USD\/EUR/);
  });

  it("throws with the provider detail on a non-2xx response", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 422,
      body: JSON.stringify({ detail: "product not found" }),
    }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-3",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/HTTP 422.*product not found/);
  });
});

describe("verifyWebhookSignature (Standard Webhooks)", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);
  const body = JSON.stringify({ type: "order.paid", data: {} });

  it("accepts a correctly signed delivery", () => {
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body, "wrong-secret"))).toBe(false);
  });

  it("rejects a stale timestamp even with a valid signature", () => {
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body, SECRET, stale))).toBe(false);
  });

  it("accepts the old secret during rotation", () => {
    const rotated = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher, {
      webhookSecret: ["new-secret", SECRET],
    });
    expect(rotated.verifyWebhookSignature(body, signedHeaders(body))).toBe(true);
  });

  it("rejects when signature headers are missing", () => {
    expect(adapter.verifyWebhookSignature(body, {})).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);

  it("maps order.paid to payment.completed keyed on the paykit reference", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "order.paid",
        data: {
          id: "order_1",
          paid: true,
          total_amount: 1999,
          currency: "usd",
          checkout_id: "co_1",
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-1" },
        },
      }),
      {},
    );
    expect(evt).not.toBeNull();
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("tx-1");
    expect(evt?.amountMicros).toBe("19990000");
    expect(evt?.currencyCode).toBe("USD");
    // The order id is what the refund API later needs.
    expect(evt?.providerPaymentId).toBe("order_1");
  });

  it("skips an order that did not originate from paykit (no metadata key)", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "order.paid",
        data: { id: "order_x", total_amount: 500, currency: "usd", metadata: {} },
      }),
      {},
    );
    expect(evt).toBeNull();
  });

  it("maps a succeeded refund to payment.refunded with its own refund id", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "refund.updated",
        data: {
          id: "ref_1",
          status: "succeeded",
          amount: 500,
          currency: "usd",
          order_id: "order_1",
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-1" },
        },
      }),
      {},
    );
    expect(evt?.type).toBe("payment.refunded");
    expect(evt?.providerRef).toBe("tx-1");
    expect(evt?.refundAmountMicros).toBe("5000000");
    expect(evt?.providerRefundId).toBe("ref_1");
  });

  it("skips pending refund updates (the succeeded one settles the row)", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "refund.updated",
        data: {
          id: "ref_1",
          status: "pending",
          amount: 500,
          currency: "usd",
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-1" },
        },
      }),
      {},
    );
    expect(evt).toBeNull();
  });

  it("skips dashboard-made refunds (no paykit metadata)", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "refund.updated",
        data: { id: "ref_2", status: "succeeded", amount: 100, currency: "usd", metadata: {} },
      }),
      {},
    );
    expect(evt).toBeNull();
  });

  it("maps checkout.updated status=expired to payment.expired", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "checkout.updated",
        data: { status: "expired", metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-9" } },
      }),
      {},
    );
    expect(evt?.type).toBe("payment.expired");
    expect(evt?.providerRef).toBe("tx-9");
  });

  it("returns null for unparseable bodies and unknown event types", () => {
    expect(adapter.parseWebhookPayload("not json", {})).toBeNull();
    expect(
      adapter.parseWebhookPayload(JSON.stringify({ type: "customer.created", data: {} }), {}),
    ).toBeNull();
  });
});

describe("refund", () => {
  it("refunds by order id and completes when Polar answers succeeded", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 201,
      body: JSON.stringify({ id: "ref_1", status: "succeeded" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 5_000_000n,
      idempotencyKey: "idem-1",
      reason: "customer request",
      providerRef: "order_1",
    });

    expect(result.state).toBe("completed");
    expect(result.providerRefundId).toBe("ref_1");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(calls[0]?.url).toBe("https://sandbox-api.polar.sh/v1/refunds/");
    expect(body.order_id).toBe("order_1");
    expect(body.amount).toBe(500);
    expect(body.metadata[PAYKIT_REFERENCE_METADATA_KEY]).toBe("tx-1");
  });

  it("maps a pending answer to pending_webhook (refund.updated settles it)", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 201,
      body: JSON.stringify({ id: "ref_2", status: "pending" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 5_000_000n,
      idempotencyKey: "idem-2",
      reason: "customer request",
      providerRef: "order_1",
    });
    expect(result.state).toBe("pending_webhook");
    expect(result.providerRefundId).toBe("ref_2");
  });

  it("fails without an order id (order.paid webhook not yet processed)", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 201, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 5_000_000n,
      idempotencyKey: "idem-3",
      reason: "customer request",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_ORDER_ID");
    expect(calls.length).toBe(0);
  });

  it("fails with the provider detail on a non-2xx response", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 400,
      body: JSON.stringify({ detail: "RefundAmountTooHigh" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 5_000_000n,
      idempotencyKey: "idem-4",
      reason: "customer request",
      providerRef: "order_1",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("HTTP_400");
    expect(result.error?.message).toContain("RefundAmountTooHigh");
  });
});

describe("fetchTransactions", () => {
  const IN_WINDOW = "2026-08-10T00:00:00Z";
  const BEFORE_WINDOW = "2026-08-01T00:00:00Z";
  const window = {
    since: new Date("2026-08-05T00:00:00Z"),
    until: new Date("2026-08-12T00:00:00Z"),
  };

  it("returns paid paykit orders in the window, keyed on the paykit reference", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: "order_1",
            paid: true,
            total_amount: 1999,
            refunded_amount: 500,
            currency: "usd",
            created_at: IN_WINDOW,
            metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-1" },
          },
          // Not paid — skipped.
          {
            id: "order_2",
            paid: false,
            total_amount: 100,
            currency: "usd",
            created_at: IN_WINDOW,
            metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-2" },
          },
          // Non-paykit order — skipped, not reported as unknown.
          {
            id: "order_3",
            paid: true,
            total_amount: 100,
            currency: "usd",
            created_at: IN_WINDOW,
            metadata: {},
          },
          // Outside the window — skipped.
          {
            id: "order_4",
            paid: true,
            total_amount: 100,
            currency: "usd",
            created_at: BEFORE_WINDOW,
            metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-4" },
          },
        ],
        pagination: { max_page: 1 },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions(window);

    expect(records).toEqual([
      {
        providerRef: "tx-1",
        amountMicros: "19990000",
        currencyCode: "USD",
        refundedAmountMicros: "5000000",
      },
    ]);
  });

  it("stops walking once a whole page predates the window (newest-first)", async () => {
    const { fetcher, calls } = mockFetch(({ url }) => {
      const page = new URL(url).searchParams.get("page");
      if (page === "1") {
        return {
          status: 200,
          body: JSON.stringify({
            items: Array.from({ length: 100 }, (_, i) => ({
              id: `order_old_${i}`,
              paid: true,
              total_amount: 100,
              currency: "usd",
              created_at: BEFORE_WINDOW,
              metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: `tx-old-${i}` },
            })),
            pagination: { max_page: 99 },
          }),
        };
      }
      throw new Error("should not fetch older pages");
    });
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions(window);
    expect(records).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("throws on HTTP failure instead of returning a misleading empty list", async () => {
    const { fetcher } = mockFetch(() => ({ status: 500, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(adapter.fetchTransactions(window)).rejects.toThrow(/HTTP 500/);
  });
});

describe("merchant-of-record tax handling", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);

  it("normalizes order.paid to the pre-tax net_amount, not the tax-inclusive total", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        type: "order.paid",
        data: {
          id: "order_tax",
          paid: true,
          net_amount: 1999,
          tax_amount: 200,
          total_amount: 2199,
          currency: "usd",
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-tax" },
        },
      }),
      {},
    );
    // The tax slice belongs to Polar as merchant of record; crediting it into
    // the paykit ledger would hand the customer balance they did not buy.
    expect(evt?.amountMicros).toBe("19990000");
  });

  it("reports settlesExactAmount false so the server compares requested vs received", () => {
    expect(adapter.settlesExactAmount).toBe(false);
  });
});
