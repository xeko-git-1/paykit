/**
 * Creem adapter tests — against a local mock of api.creem.io.
 *
 * Covers:
 *   - createCheckout: product_id + request_id + custom_price body,
 *     providerSessionId = checkout id, unsupported currency rejection
 *   - creem-signature verification: valid, wrong secret, rotation, missing
 *   - parseWebhookPayload: checkout.completed → payment.completed (license
 *     metadata pass-through); refund.created → payment.refunded keyed on the
 *     checkout id; checkout.expired → payment.expired; garbage skipped
 *   - refund: always 'unsupported' (dashboard-only), no HTTP call
 *   - fetchTransactions: client-side window filter, pagination, HTTP error
 *     throws
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PAYKIT_REFERENCE_METADATA_KEY, createCreemAdapter } from "../src/adapter.js";

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

const SECRET = "whsec_creem_test";

function makeAdapter(fetcher: typeof fetch, opts?: { webhookSecret?: string | string[] }) {
  return createCreemAdapter({
    apiKey: "creem_test_key",
    productId: "prod_abc",
    webhookSecret: opts?.webhookSecret ?? SECRET,
    testMode: true,
    fetcher,
  });
}

function signedHeaders(body: string, secret: string = SECRET): Record<string, string> {
  return { "creem-signature": createHmac("sha256", secret).update(body).digest("hex") };
}

describe("createCheckout", () => {
  it("creates a session over the product with a custom_price and returns the checkout id", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        id: "ch_1",
        checkout_url: "https://checkout.creem.io/ch_1",
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.createCheckout({
      transactionId: "tx-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 19_990_000n, // USD 19.99
      currencyCode: "USD",
      customerEmail: "a@b.co",
    });

    expect(result.webUrl).toBe("https://checkout.creem.io/ch_1");
    // provider_ref = the checkout id: it is object.id on checkout.completed
    // and the key a dashboard refund's webhook points back at.
    expect(result.providerSessionId).toBe("ch_1");

    expect(calls[0]?.url).toBe("https://test-api.creem.io/v1/checkouts");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.product_id).toBe("prod_abc");
    expect(body.request_id).toBe("tx-1");
    expect(body.custom_price).toBe(1999);
    expect(body.metadata[PAYKIT_REFERENCE_METADATA_KEY]).toBe("tx-1");
    expect(body.customer).toEqual({ email: "a@b.co" });
  });

  it("rejects currencies Creem does not settle", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
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

  it("throws with the provider message on a non-2xx response", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 403,
      body: JSON.stringify({ message: "invalid api key" }),
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
    ).rejects.toThrow(/HTTP 403.*invalid api key/);
  });
});

describe("verifyWebhookSignature (creem-signature)", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);
  const body = JSON.stringify({ eventType: "checkout.completed", object: {} });

  it("accepts a correctly signed delivery", () => {
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(adapter.verifyWebhookSignature(body, signedHeaders(body, "wrong"))).toBe(false);
  });

  it("accepts the old secret during rotation", () => {
    const rotated = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher, {
      webhookSecret: ["whsec_new", SECRET],
    });
    expect(rotated.verifyWebhookSignature(body, signedHeaders(body))).toBe(true);
  });

  it("rejects when the header is missing", () => {
    expect(adapter.verifyWebhookSignature(body, {})).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);

  it("maps checkout.completed to payment.completed keyed on the checkout id", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        id: "evt_1",
        eventType: "checkout.completed",
        object: {
          id: "ch_1",
          status: "completed",
          request_id: "tx-1",
          order: { id: "ord_1", amount: 1999, currency: "USD", status: "paid" },
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-1" },
          license: { key: "ABCD-EFGH", activation_limit: 3 },
        },
      }),
      {},
    );
    expect(evt).not.toBeNull();
    expect(evt?.eventId).toBe("evt_1");
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("ch_1");
    expect(evt?.amountMicros).toBe("19990000");
    expect(evt?.currencyCode).toBe("USD");
    expect(evt?.providerPaymentId).toBe("ord_1");
    // Licensing pass-through: the consumer persists/delivers the key.
    expect(evt?.metadata.license).toEqual({ key: "ABCD-EFGH", activation_limit: 3 });
    expect(evt?.metadata.requestId).toBe("tx-1");
  });

  it("tolerates snake_case event_type envelopes", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        event_type: "checkout.completed",
        object: { id: "ch_2", order: { amount: 100, currency: "USD" } },
      }),
      {},
    );
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("ch_2");
  });

  it("skips a completed checkout whose order is not paid", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        eventType: "checkout.completed",
        object: { id: "ch_3", order: { amount: 100, currency: "USD", status: "pending" } },
      }),
      {},
    );
    expect(evt).toBeNull();
  });

  it("maps refund.created to payment.refunded keyed on the refunded checkout", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        id: "evt_2",
        eventType: "refund.created",
        object: {
          id: "ref_1",
          status: "succeeded",
          refund_amount: 500,
          refund_currency: "USD",
          checkout: { id: "ch_1" },
        },
      }),
      {},
    );
    expect(evt?.type).toBe("payment.refunded");
    expect(evt?.providerRef).toBe("ch_1");
    expect(evt?.refundAmountMicros).toBe("5000000");
    expect(evt?.providerRefundId).toBe("ref_1");
  });

  it("accepts a refund whose checkout is a bare id string", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        eventType: "refund.created",
        object: { id: "ref_2", amount: 100, currency: "USD", checkout: "ch_9" },
      }),
      {},
    );
    expect(evt?.providerRef).toBe("ch_9");
    expect(evt?.refundAmountMicros).toBe("1000000");
  });

  it("maps checkout.expired to payment.expired", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({ eventType: "checkout.expired", object: { id: "ch_1" } }),
      {},
    );
    expect(evt?.type).toBe("payment.expired");
    expect(evt?.providerRef).toBe("ch_1");
  });

  it("returns null for unparseable bodies and unknown event types", () => {
    expect(adapter.parseWebhookPayload("not json", {})).toBeNull();
    expect(
      adapter.parseWebhookPayload(
        JSON.stringify({ eventType: "subscription.active", object: {} }),
        {},
      ),
    ).toBeNull();
  });
});

describe("refund", () => {
  it("answers unsupported without calling Creem (dashboard-only refunds)", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 1_000_000n,
      idempotencyKey: "idem-1",
      reason: "customer request",
      providerRef: "ch_1",
    });
    expect(result.state).toBe("unsupported");
    expect(result.error?.providerCode).toBe("DASHBOARD_ONLY");
    expect(calls.length).toBe(0);
  });
});

describe("fetchTransactions", () => {
  const window = {
    since: new Date("2026-08-05T00:00:00Z"),
    until: new Date("2026-08-12T00:00:00Z"),
  };

  it("filters the window client-side and keys records on checkout_id", async () => {
    const inWindow = Date.parse("2026-08-10T00:00:00Z");
    const beforeWindow = Date.parse("2026-08-01T00:00:00Z");
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: "t1",
            amount: 1999,
            currency: "USD",
            status: "paid",
            created_at: inWindow,
            checkout_id: "ch_1",
          },
          // Outside the window — skipped.
          {
            id: "t2",
            amount: 100,
            currency: "USD",
            status: "paid",
            created_at: beforeWindow,
            checkout_id: "ch_2",
          },
          // No checkout id (pre-paykit row) — skipped.
          { id: "t3", amount: 100, currency: "USD", status: "paid", created_at: inWindow },
          // Not settled — skipped.
          {
            id: "t4",
            amount: 100,
            currency: "USD",
            status: "pending",
            created_at: inWindow,
            checkout_id: "ch_4",
          },
        ],
        pagination: { total_pages: 1 },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions(window);

    expect(records).toEqual([
      { providerRef: "ch_1", amountMicros: "19990000", currencyCode: "USD" },
    ]);
  });

  it("accepts epoch-second timestamps", async () => {
    const inWindowSeconds = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        items: [
          {
            id: "t1",
            amount: 500,
            currency: "USD",
            status: "paid",
            created_at: inWindowSeconds,
            checkout_id: "ch_s",
          },
        ],
        pagination: { total_pages: 1 },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions(window);
    expect(records).toEqual([
      { providerRef: "ch_s", amountMicros: "5000000", currencyCode: "USD" },
    ]);
  });

  it("walks pagination to the last page", async () => {
    const inWindow = Date.parse("2026-08-10T00:00:00Z");
    const { fetcher, calls } = mockFetch(({ url }) => {
      const page = new URL(url).searchParams.get("page_number");
      return {
        status: 200,
        body: JSON.stringify({
          items: Array.from({ length: page === "2" ? 1 : 100 }, (_, i) => ({
            id: `t${page}-${i}`,
            amount: 100,
            currency: "USD",
            status: "paid",
            created_at: inWindow,
            checkout_id: `ch_${page}_${i}`,
          })),
          pagination: { total_pages: 2 },
        }),
      };
    });
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions(window);
    expect(records.length).toBe(101);
    expect(calls.length).toBe(2);
  });

  it("throws on HTTP failure instead of returning a misleading empty list", async () => {
    const { fetcher } = mockFetch(() => ({ status: 500, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(adapter.fetchTransactions(window)).rejects.toThrow(/HTTP 500/);
  });
});

describe("merchant-of-record tax handling", () => {
  const adapter = makeAdapter(mockFetch(() => ({ status: 200, body: "{}" })).fetcher);

  it("normalizes checkout.completed to the pre-tax sub_total, not the tax-inclusive amount", () => {
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        id: "evt_tax",
        eventType: "checkout.completed",
        object: {
          id: "ch_tax",
          order: {
            id: "ord_tax",
            amount: 2199,
            sub_total: 1999,
            tax_amount: 200,
            currency: "USD",
            status: "paid",
          },
          metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: "tx-tax" },
        },
      }),
      {},
    );
    // The tax slice belongs to Creem as merchant of record; crediting it into
    // the paykit ledger would hand the customer balance they did not buy.
    expect(evt?.amountMicros).toBe("19990000");
  });

  it("reports settlesExactAmount false so the server compares requested vs received", () => {
    expect(adapter.settlesExactAmount).toBe(false);
  });
});
