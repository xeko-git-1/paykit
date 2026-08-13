import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApipayAdapter } from "../src/adapter.js";

const baseConfig = {
  accessKey: "ak_test",
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  bankPublicId: "bnk_abc123",
};

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createApipayAdapter — adapter contract", () => {
  const adapter = createApipayAdapter(baseConfig);

  it("id defaults to 'apipay'", () => {
    expect(adapter.id).toBe("apipay");
  });

  it("supportedCurrencies = ['VND']", () => {
    expect(adapter.supportedCurrencies).toEqual(["VND"]);
  });

  it("checkoutMode = 'redirect'", () => {
    expect(adapter.checkoutMode).toBe("redirect");
  });

  it("settlesExactAmount = false (payer-controlled bank transfer)", () => {
    expect(adapter.settlesExactAmount).toBe(false);
  });
});

describe("createApipayAdapter — createCheckout", () => {
  it("posts a payment request with VND amount, brand-prefixed content, and auth header", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: {
          publicId: "APIPAYJSC1",
          payUrl: "https://pay.apipay.vn/APIPAYJSC1",
          qrUrl: "https://api.qrserver.com/qr.png",
        },
      }),
    );
    const adapter = createApipayAdapter({ ...baseConfig, fetcher: fetcher as typeof fetch });

    const result = await adapter.createCheckout({
      transactionId: "abc-123",
      tenantId: "t-1",
      ownerId: "o-1",
      amountMicros: 100_000_000_000n, // 100,000 VND
      currencyCode: "VND",
      returnUrl: "https://myapp/return",
      orderInfo: "Don hang 1",
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.apipay.vn/v1/client/payment-requests");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Bearer ${Buffer.from("ak_test:sk_test").toString("base64")}`,
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.bankPublicId).toBe("bnk_abc123");
    expect(body.amount).toBe("100000");
    expect(body.content).toBe("PAYKIT abc-123");
    expect(body.title).toBe("Don hang 1");
    expect(body.redirectUrl).toBe("https://myapp/return");

    expect(result.webUrl).toBe("https://pay.apipay.vn/APIPAYJSC1");
    expect(result.qrUrl).toBe("https://api.qrserver.com/qr.png");
    expect(result.providerSessionId).toBeUndefined();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("custom brandPrefix changes content", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: { payUrl: "https://pay.apipay.vn/X" } }),
    );
    const adapter = createApipayAdapter({
      ...baseConfig,
      brandPrefix: "MYAPP",
      fetcher: fetcher as typeof fetch,
    });
    await adapter.createCheckout({
      transactionId: "x-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000n,
      currencyCode: "VND",
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.content).toBe("MYAPP x-1");
  });

  it("rejects non-VND currency", async () => {
    const adapter = createApipayAdapter(baseConfig);
    await expect(
      adapter.createCheckout({
        transactionId: "abc",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/VND only/);
  });

  it("throws on non-2xx response", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "invalid bank" }, 400));
    const adapter = createApipayAdapter({ ...baseConfig, fetcher: fetcher as typeof fetch });
    await expect(
      adapter.createCheckout({
        transactionId: "abc",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it("throws when response has no payUrl", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: {} }));
    const adapter = createApipayAdapter({ ...baseConfig, fetcher: fetcher as typeof fetch });
    await expect(
      adapter.createCheckout({
        transactionId: "abc",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/no payUrl/);
  });
});

describe("createApipayAdapter — webhook signature", () => {
  it("verifies with single secret string", () => {
    const adapter = createApipayAdapter(baseConfig);
    const payload = JSON.stringify({ event: "transaction.in", data: {} });
    expect(
      adapter.verifyWebhookSignature(payload, {
        "apipay-signature": sign(payload, "whsec_test"),
      }),
    ).toBe(true);
  });

  it("verifies with rotation array", () => {
    const adapter = createApipayAdapter({
      ...baseConfig,
      webhookSecret: ["whsec_old", "whsec_new"],
    });
    const payload = JSON.stringify({ event: "transaction.in" });
    expect(
      adapter.verifyWebhookSignature(payload, {
        "apipay-signature": sign(payload, "whsec_old"),
      }),
    ).toBe(true);
  });

  it("accepts the mixed-case header spelling", () => {
    const adapter = createApipayAdapter(baseConfig);
    const payload = JSON.stringify({ event: "transaction.in" });
    expect(
      adapter.verifyWebhookSignature(payload, {
        "ApiPay-Signature": sign(payload, "whsec_test"),
      }),
    ).toBe(true);
  });

  it("rejects bad signature", () => {
    const adapter = createApipayAdapter(baseConfig);
    expect(adapter.verifyWebhookSignature("payload", { "apipay-signature": "bad" })).toBe(false);
  });

  it("rejects signature computed with empty secret (forgery vector)", () => {
    const adapter = createApipayAdapter({ ...baseConfig, webhookSecret: [""] });
    const payload = JSON.stringify({ event: "transaction.in" });
    const forgedSig = sign(payload, "");
    expect(adapter.verifyWebhookSignature(payload, { "apipay-signature": forgedSig })).toBe(false);
  });
});

describe("createApipayAdapter — parseWebhookPayload", () => {
  const adapter = createApipayAdapter(baseConfig);

  it("transaction.in with matching content → payment.completed", () => {
    const payload = JSON.stringify({
      event: "transaction.in",
      data: {
        transactionId: "550e8400-e29b-41d4-a716-446655440000",
        referenceCode: "TX123456789",
        amount: "100000",
        content: "PAYKIT abc-123",
        transactionDate: "2026-03-06T10:30:00Z",
        bankAccountPublicId: "bk_abcdef",
        gateway: "MBB",
        accountNumber: "0123456789",
      },
    });
    const result = adapter.parseWebhookPayload(payload, {});
    expect(result?.type).toBe("payment.completed");
    expect(result?.providerRef).toBe("abc-123");
    expect(result?.amountMicros).toBe("100000000000"); // 100,000 × 1M micros
    expect(result?.currencyCode).toBe("VND");
    expect(result?.eventId).toBe("apipay:550e8400-e29b-41d4-a716-446655440000");
    expect(result?.metadata.referenceCode).toBe("TX123456789");
  });

  it("numeric amount is accepted", () => {
    const payload = JSON.stringify({
      event: "transaction.in",
      data: { transactionId: "id-1", amount: 50000, content: "PAYKIT z-9" },
    });
    const result = adapter.parseWebhookPayload(payload, {});
    expect(result?.amountMicros).toBe("50000000000");
  });

  it("non-'transaction.in' event → null (skip)", () => {
    const payload = JSON.stringify({
      event: "transaction.out",
      data: { transactionId: "id-2", amount: "50000", content: "PAYKIT xyz" },
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("missing orderId in content → null (skip unmatched)", () => {
    const payload = JSON.stringify({
      event: "transaction.in",
      data: { transactionId: "id-3", amount: "1000", content: "random transfer note" },
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("non-integral amount → null", () => {
    const payload = JSON.stringify({
      event: "transaction.in",
      data: { transactionId: "id-4", amount: "10.5", content: "PAYKIT ok-1" },
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("malformed JSON → null", () => {
    expect(adapter.parseWebhookPayload("not-json", {})).toBeNull();
  });
});

describe("createApipayAdapter — refund", () => {
  it("returns state='unsupported' with pointer to /admin/billing/ledger/adjust", async () => {
    const adapter = createApipayAdapter(baseConfig);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 1_000_000n,
      idempotencyKey: "key-1",
      reason: "customer dispute",
    });
    expect(result.state).toBe("unsupported");
    expect(result.error?.providerCode).toBe("APIPAY_REFUND_UNSUPPORTED");
    expect(result.error?.message).toContain("ledger/adjust");
  });
});

describe("createApipayAdapter — fetchTransactions", () => {
  function listPage(
    rows: ReadonlyArray<{ content: string | null; amount: string | number | null }>,
  ) {
    return jsonResponse({
      data: {
        status: true,
        data: rows.map((r, i) => ({
          publicId: `pr-${i}`,
          status: "COMPLETED",
          content: r.content,
          amount: r.amount,
        })),
        pagination: { page: 1, limit: 100, total: rows.length, totalPages: 1 },
      },
    });
  }

  it("lists COMPLETED requests and converts VND amounts to micros", async () => {
    const fetcher = vi.fn(async () =>
      listPage([
        { content: "PAYKIT order-A", amount: "100000" },
        { content: "no match here", amount: "5000" },
        { content: "PAYKIT order-B", amount: null }, // customer-typed amount → skipped
      ]),
    );
    const adapter = createApipayAdapter({ ...baseConfig, fetcher: fetcher as typeof fetch });
    const result = await adapter.fetchTransactions({ since: new Date("2026-01-01") });

    expect(result).toHaveLength(1);
    expect(result[0]?.providerRef).toBe("order-A");
    expect(result[0]?.amountMicros).toBe("100000000000");
    expect(result[0]?.currencyCode).toBe("VND");

    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(url).toContain("status=COMPLETED");
    expect(url).toContain("limit=100");
    expect(url).toContain("dateFrom=");
  });

  it("follows pages until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      content: `PAYKIT bulk-${i}`,
      amount: "1000",
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(listPage(fullPage))
      .mockResolvedValueOnce(listPage([{ content: "PAYKIT last-1", amount: "2000" }]));
    const adapter = createApipayAdapter({ ...baseConfig, fetcher: fetcher as typeof fetch });
    const result = await adapter.fetchTransactions({ since: new Date("2026-01-01") });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
    const [secondUrl] = fetcher.mock.calls[1] as unknown as [string];
    expect(secondUrl).toContain("page=2");
  });

  it("throws on non-2xx instead of returning a partial list", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    const adapter = createApipayAdapter({ ...baseConfig, fetcher: fetcher as typeof fetch });
    await expect(adapter.fetchTransactions({ since: new Date() })).rejects.toThrow(/HTTP 500/);
  });
});
