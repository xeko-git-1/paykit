/**
 * Cryptomus adapter tests.
 *
 * Covers:
 *   - createCheckout: USD amount conversion, non-USD rejection, order_id
 *     round-trip, no providerSessionId (so server keys on transactionId)
 *   - signed request: merchant + sign headers, body bytes == signed bytes
 *   - webhook verify: valid sign passes, tampered body fails
 *   - refund: missing order_id → failed; 2xx → pending_webhook; 5xx → pending_webhook
 *   - providerRef round-trip invariant: checkout ref == webhook providerRef
 */
import { describe, expect, it } from "vitest";
import { createCryptomusAdapter } from "../src/adapter.js";
import { computeCryptomusSign, phpJsonEncode } from "../src/webhook-verifier.js";

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(body !== undefined ? { url, method, headers, body } : { url, method, headers });
    const result = responder({ url, init });
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

function makeAdapter(
  fetcher: typeof fetch,
  opts?: Partial<Parameters<typeof createCryptomusAdapter>[0]>,
): ReturnType<typeof createCryptomusAdapter> {
  return createCryptomusAdapter({
    merchantId: "merchant-uuid-1",
    paymentApiKey: "test-payment-key",
    fetcher,
    ...opts,
  });
}

describe("createCheckout", () => {
  it("converts amountMicros to USD amount and round-trips transactionId as order_id", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        state: 0,
        result: {
          uuid: "cm-uuid-99",
          order_id: "tx-uuid-1",
          url: "https://pay.cryptomus.com/pay/abc",
        },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.createCheckout({
      transactionId: "tx-uuid-1",
      tenantId: "tenant-1",
      ownerId: "owner-1",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://pay.cryptomus.com/pay/abc");
    expect(result.qrUrl).toBe("https://pay.cryptomus.com/pay/abc");
    // No providerSessionId → server stores provider_ref = transactionId, which
    // Cryptomus echoes as order_id in every webhook.
    expect(result.providerSessionId).toBeUndefined();

    const call = calls[0];
    expect(call?.url).toBe("https://api.cryptomus.com/v1/payment");
    expect(call?.headers.merchant).toBe("merchant-uuid-1");
    expect(typeof call?.headers.sign).toBe("string");
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.amount).toBe("50.00");
    expect(body.currency).toBe("USD");
    expect(body.order_id).toBe("tx-uuid-1");
  });

  it("sends the exact bytes the sign was computed over (PHP slash-escaping)", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ state: 0, result: { url: "https://pay.cryptomus.com/pay/x" } }),
    }));
    const adapter = makeAdapter(fetcher, { callbackUrl: "https://app.example/webhooks/cryptomus" });
    await adapter.createCheckout({
      transactionId: "tx-2",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000n,
      currencyCode: "USD",
    });
    const call = calls[0];
    // The URL in the body must carry escaped slashes so the MD5 matches.
    expect(call?.body).toContain("https:\\/\\/app.example\\/webhooks\\/cryptomus");
    // And the sign header must equal a re-computation over the same body object.
    const sentBody = call?.body ?? "";
    // Recompute sign from the parsed object and confirm the header matches.
    const reparsed = JSON.parse(sentBody);
    const { sign } = computeCryptomusSign(reparsed, "test-payment-key");
    expect(call?.headers.sign).toBe(sign);
  });

  it("rejects non-USD currency", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-3",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD/);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a body whose sign matches, rejects a tampered body", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);

    const payload = {
      type: "payment",
      uuid: "cm-uuid-99",
      order_id: "tx-uuid-1",
      status: "paid",
      amount: "50.00",
      payment_amount_usd: "50.00",
    };
    // The webhook sign is MD5( base64(phpJsonEncode(body-without-sign)) + key ).
    const { sign } = computeCryptomusSign(payload, "test-payment-key");
    const signed = JSON.stringify({ ...payload, sign });
    expect(adapter.verifyWebhookSignature(signed, {})).toBe(true);

    // Tamper the amount after signing → verification fails.
    const tampered = JSON.stringify({ ...payload, amount: "5000.00", sign });
    expect(adapter.verifyWebhookSignature(tampered, {})).toBe(false);
  });

  it("rejects a body with no sign field", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    expect(adapter.verifyWebhookSignature(JSON.stringify({ order_id: "x" }), {})).toBe(false);
  });
});

describe("parseWebhookPayload — round-trip with checkout", () => {
  it("maps paid → payment.completed and keys providerRef on order_id (= transactionId)", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        uuid: "cm-uuid-99",
        order_id: "tx-uuid-1",
        status: "paid",
        amount: "50.00",
        payment_amount_usd: "50.00",
        currency: "USD",
      }),
      {},
    );
    expect(evt?.type).toBe("payment.completed");
    // The provider_ref the server stored at checkout (fallback = transactionId)
    // MUST equal the webhook's providerRef, or the router lookup misses the row.
    expect(evt?.providerRef).toBe("tx-uuid-1");
    expect(evt?.amountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
  });

  it("maps refund_paid → payment.refunded with refundAmountMicros", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        order_id: "tx-uuid-1",
        status: "refund_paid",
        amount: "50.00",
        payment_amount_usd: "50.00",
      }),
      {},
    );
    expect(evt?.type).toBe("payment.refunded");
    // Without refundAmountMicros the webhook-router refund case early-returns.
    expect(evt?.refundAmountMicros).toBe("50000000");
  });
});

describe("refund", () => {
  it("returns failed with MISSING_ORDER_ID when providerRef absent", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_ORDER_ID");
  });

  it("returns pending_webhook on 2xx (refund confirmed async via webhook)", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ state: 0, result: { result: true } }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "tx-uuid-1",
    });
    expect(result.state).toBe("pending_webhook");
    const refundCall = calls.find((c) => c.url.includes("/v1/payment/refund"));
    expect(refundCall?.method).toBe("POST");
    const body = JSON.parse(refundCall?.body ?? "{}");
    expect(body.order_id).toBe("tx-uuid-1");
  });

  it("returns pending_webhook on 5xx", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 502,
      body: JSON.stringify({ message: "Bad Gateway" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "tx-uuid-1",
    });
    expect(result.state).toBe("pending_webhook");
    expect(result.error?.providerCode).toBe("HTTP_502");
  });
});

describe("fetchTransactions", () => {
  it("returns USD-normalized records for paid payments only", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        state: 0,
        result: {
          items: [
            { order_id: "tx-a", status: "paid", amount: "10.00", payment_amount_usd: "10.00" },
            { order_id: "tx-b", status: "check", amount: "20.00" },
            { order_id: "tx-c", status: "paid_over", amount: "30.00", payment_amount_usd: "30.50" },
          ],
        },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions({ since: new Date("2026-01-01") });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.providerRef).sort()).toEqual(["tx-a", "tx-c"]);
    expect(records.find((r) => r.providerRef === "tx-a")?.amountMicros).toBe("10000000");
  });
});

describe("phpJsonEncode", () => {
  it("escapes forward slashes like PHP json_encode", () => {
    expect(phpJsonEncode({ url: "https://x.io/a" })).toBe('{"url":"https:\\/\\/x.io\\/a"}');
  });
});
