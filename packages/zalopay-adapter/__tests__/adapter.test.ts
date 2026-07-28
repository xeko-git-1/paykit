/**
 * ZaloPay adapter tests — createCheckout, webhook verify/parse, 2-step refund.
 *
 * The adapter calls global `fetch` (no injectable fetcher), so each test stubs
 * globalThis.fetch via vi.stubGlobal and restores it afterwards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZaloPayAdapter } from "../src/adapter.js";
import { buildCreateCanonical, signWithKey1, signWithKey2 } from "../src/signature.js";

const KEY1 = "key1_secret";
const KEY2 = "key2_secret";

const baseConfig = {
  appId: "2553",
  key1: KEY1,
  key2: KEY2,
  returnUrl: "https://app.example/return",
  callbackUrl: "https://app.example/zalopay/callback",
};

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

/** Install a fake global fetch; returns recorded calls for assertion. */
function mockFetch(
  responder: (input: { url: string; init?: RequestInit }) => {
    status: number;
    body: string;
  },
): { calls: MockCall[] } {
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
  vi.stubGlobal("fetch", fetcher);
  return { calls };
}

/** Fake fetch that rejects, to exercise the catch branches. */
function mockFetchThrows(message: string): void {
  vi.stubGlobal("fetch", (async () => {
    throw new Error(message);
  }) as typeof fetch);
}

/** Build the `{ data, mac }` envelope ZaloPay POSTs to the callback URL. */
function buildCallbackBody(data: Record<string, unknown>, key2 = KEY2, type?: number): string {
  const dataStr = JSON.stringify(data);
  return JSON.stringify({
    data: dataStr,
    mac: signWithKey2(dataStr, key2),
    ...(type !== undefined ? { type } : {}),
  });
}

const CHECKOUT_OK = JSON.stringify({
  return_code: 1,
  return_message: "Success",
  order_url: "https://sbgateway.zalopay.vn/pay?order=abc",
  zp_trans_token: "ACg5Zzt1",
});

const checkoutInput = {
  transactionId: "a0000000-0000-4000-8000-000000000042",
  tenantId: "tenant-1",
  ownerId: "owner-1",
  amountMicros: 100_000_000_000n, // 100,000 VND
  currencyCode: "VND" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adapter contract", () => {
  const adapter = createZaloPayAdapter(baseConfig);

  it("id defaults to 'zalopay' and is overridable", () => {
    expect(adapter.id).toBe("zalopay");
    expect(createZaloPayAdapter({ ...baseConfig, id: "zalopay-alt" }).id).toBe("zalopay-alt");
  });

  it("supports VND only, redirect mode", () => {
    expect(adapter.supportedCurrencies).toEqual(["VND"]);
    expect(adapter.checkoutMode).toBe("redirect");
    expect(adapter.displayName).toBe("ZaloPay");
  });

  it("fetchTransactions returns empty (reconciler iterates paykit rows instead)", async () => {
    const records = await adapter.fetchTransactions({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-02T00:00:00Z"),
    });
    expect(records).toEqual([]);
  });
});

describe("createCheckout", () => {
  it("posts /v2/create with app_trans_id YYMMDD_<12-char tx suffix> and VND amount", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);

    const result = await adapter.createCheckout(checkoutInput);

    expect(calls[0]?.url).toBe("https://sb-openapi.zalopay.vn/v2/create");
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}");

    // YYMMDD prefix computed in UTC+7 (Vietnam), suffix = uuid minus dashes, 12 chars.
    const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const yymmdd =
      String(vnNow.getUTCFullYear()).slice(-2) +
      String(vnNow.getUTCMonth() + 1).padStart(2, "0") +
      String(vnNow.getUTCDate()).padStart(2, "0");
    expect(body.app_trans_id).toBe(`${yymmdd}_a00000000000`);
    expect(result.providerSessionId).toBe(body.app_trans_id);

    // amountMicros / 1e6 → integer VND (ZaloPay has no sub-unit).
    expect(body.amount).toBe(100_000);
    expect(body.app_id).toBe(2553);
    expect(body.app_user).toBe("tenant-1");
    expect(body.callback_url).toBe(baseConfig.callbackUrl);
    expect(body.item).toBe("[]");
  });

  it("signs the create body with key1 over the pipe canonical", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);
    await adapter.createCheckout(checkoutInput);

    const body = JSON.parse(calls[0]?.body ?? "{}");
    const expected = signWithKey1(
      buildCreateCanonical({
        appId: baseConfig.appId,
        appTransId: body.app_trans_id,
        appUser: body.app_user,
        amount: String(body.amount),
        appTime: String(body.app_time),
        embedData: body.embed_data,
        item: body.item,
      }),
      KEY1,
    );
    expect(body.mac).toBe(expected);
    // key2 must NOT sign outbound requests (2-key separation).
    expect(body.mac).not.toBe(signWithKey2("x", KEY2));
  });

  it("embeds redirect url and paykit transactionId in embed_data", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);
    await adapter.createCheckout({ ...checkoutInput, returnUrl: "https://app.example/custom" });

    const embed = JSON.parse(JSON.parse(calls[0]?.body ?? "{}").embed_data);
    expect(embed.redirecturl).toBe("https://app.example/custom");
    expect(embed.paykitTransactionId).toBe(checkoutInput.transactionId);
  });

  it("falls back to config.returnUrl when input.returnUrl is absent", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);
    await adapter.createCheckout(checkoutInput);

    const embed = JSON.parse(JSON.parse(calls[0]?.body ?? "{}").embed_data);
    expect(embed.redirecturl).toBe(baseConfig.returnUrl);
  });

  it("returns order_url as webUrl and derives mobileDeeplink from zp_trans_token", async () => {
    mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.createCheckout(checkoutInput);

    expect(result.webUrl).toBe("https://sbgateway.zalopay.vn/pay?order=abc");
    expect(result.mobileDeeplink).toBe("zalopay://app/payment?token=ACg5Zzt1");
    expect(result.qrUrl).toBeUndefined();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("omits mobileDeeplink when ZaloPay returns no zp_trans_token; maps qr_code → qrUrl", async () => {
    mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        return_code: 1,
        order_url: "https://sbgateway.zalopay.vn/pay?order=xyz",
        qr_code: "https://qr.zalopay.vn/xyz.png",
      }),
    }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.createCheckout(checkoutInput);

    expect(result.mobileDeeplink).toBeUndefined();
    expect(result.qrUrl).toBe("https://qr.zalopay.vn/xyz.png");
  });

  it("uses production host when environment='production'", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter({ ...baseConfig, environment: "production" });
    await adapter.createCheckout(checkoutInput);

    expect(calls[0]?.url).toBe("https://openapi.zalopay.vn/v2/create");
  });

  it("rejects non-VND currency before any network call", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);

    await expect(adapter.createCheckout({ ...checkoutInput, currencyCode: "USD" })).rejects.toThrow(
      /VND only/,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws when return_code !== 1", async () => {
    mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ return_code: 2, return_message: "Duplicate app_trans_id" }),
    }));
    const adapter = createZaloPayAdapter(baseConfig);

    await expect(adapter.createCheckout(checkoutInput)).rejects.toThrow(
      /create-order failed: 2 Duplicate app_trans_id/,
    );
  });

  it("throws on non-2xx HTTP", async () => {
    mockFetch(() => ({ status: 503, body: "upstream down" }));
    const adapter = createZaloPayAdapter(baseConfig);

    await expect(adapter.createCheckout(checkoutInput)).rejects.toThrow(/HTTP 503/);
  });
});

describe("providerRef round-trip (checkout ↔ webhook)", () => {
  it("providerSessionId from createCheckout equals providerRef from parseWebhookPayload", async () => {
    mockFetch(() => ({ status: 200, body: CHECKOUT_OK }));
    const adapter = createZaloPayAdapter(baseConfig);

    const checkout = await adapter.createCheckout(checkoutInput);
    // Server persistence rule: provider_ref = providerSessionId ?? transactionId.
    const storedProviderRef = checkout.providerSessionId ?? checkoutInput.transactionId;

    // ZaloPay echoes the same app_trans_id in the callback data.
    const evt = adapter.parseWebhookPayload(
      buildCallbackBody({
        app_id: 2553,
        app_trans_id: checkout.providerSessionId,
        amount: 100_000,
        zp_trans_id: "220101000000123",
        server_time: 1_700_000_000_000,
      }),
      {},
    );

    // If these diverge the webhook lookup finds no row and the payment never credits.
    expect(evt?.providerRef).toBe(storedProviderRef);
    expect(storedProviderRef).not.toBe(checkoutInput.transactionId);
    expect(evt?.amountMicros).toBe(checkoutInput.amountMicros.toString());
  });
});

describe("verifyWebhookSignature", () => {
  const adapter = createZaloPayAdapter(baseConfig);
  const data = { app_id: 2553, app_trans_id: "260523_abc", amount: 100_000 };

  it("accepts a mac computed with key2 over the raw data field", () => {
    expect(adapter.verifyWebhookSignature(buildCallbackBody(data), {})).toBe(true);
  });

  it("accepts either key during key2 rotation", () => {
    const rotating = createZaloPayAdapter({ ...baseConfig, key2: ["k2_old", "k2_new"] });
    expect(rotating.verifyWebhookSignature(buildCallbackBody(data, "k2_old"), {})).toBe(true);
    expect(rotating.verifyWebhookSignature(buildCallbackBody(data, "k2_new"), {})).toBe(true);
    expect(rotating.verifyWebhookSignature(buildCallbackBody(data, "k2_evil"), {})).toBe(false);
  });

  it("rejects a mac signed with the wrong key", () => {
    expect(adapter.verifyWebhookSignature(buildCallbackBody(data, "wrong_key"), {})).toBe(false);
  });

  it("rejects a mac signed with key1 (2-key separation)", () => {
    const dataStr = JSON.stringify(data);
    const raw = JSON.stringify({ data: dataStr, mac: signWithKey1(dataStr, KEY1) });
    expect(adapter.verifyWebhookSignature(raw, {})).toBe(false);
  });

  it("rejects tampered data whose mac was computed over the original", () => {
    const original = JSON.stringify(data);
    const raw = JSON.stringify({
      data: JSON.stringify({ ...data, amount: 1 }),
      mac: signWithKey2(original, KEY2),
    });
    expect(adapter.verifyWebhookSignature(raw, {})).toBe(false);
  });

  it("rejects empty or missing mac", () => {
    const dataStr = JSON.stringify(data);
    expect(adapter.verifyWebhookSignature(JSON.stringify({ data: dataStr, mac: "" }), {})).toBe(
      false,
    );
    expect(adapter.verifyWebhookSignature(JSON.stringify({ data: dataStr }), {})).toBe(false);
  });

  it("fails closed when configured key2 is empty (no attacker-computable digest)", () => {
    const misconfigured = createZaloPayAdapter({ ...baseConfig, key2: "" });
    expect(misconfigured.verifyWebhookSignature(buildCallbackBody(data, ""), {})).toBe(false);
  });

  it("returns false on malformed JSON body", () => {
    expect(adapter.verifyWebhookSignature("not-json", {})).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  const adapter = createZaloPayAdapter(baseConfig);

  it("maps a success callback to payment.completed with VND micros and stable eventId", () => {
    const evt = adapter.parseWebhookPayload(
      buildCallbackBody(
        {
          app_id: 2553,
          app_trans_id: "260523_abc",
          amount: 100_000,
          zp_trans_id: "220101000000123",
          server_time: 1_700_000_000_000,
        },
        KEY2,
        1,
      ),
      {},
    );

    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("260523_abc");
    expect(evt?.amountMicros).toBe("100000000000");
    expect(evt?.currencyCode).toBe("VND");
    expect(evt?.eventId).toBe("zalopay:260523_abc:220101000000123");
    expect((evt?.metadata as { zpTransId?: string })?.zpTransId).toBe("220101000000123");
    expect((evt?.metadata as { callbackType?: number })?.callbackType).toBe(1);
  });

  it("defaults callbackType to 1 (order success) when type is absent", () => {
    const evt = adapter.parseWebhookPayload(
      buildCallbackBody({ app_id: 2553, app_trans_id: "260523_def", amount: 5_000 }),
      {},
    );
    expect(evt?.type).toBe("payment.completed");
    expect((evt?.metadata as { callbackType?: number })?.callbackType).toBe(1);
    // zp_trans_id absent → eventId falls back to '0' suffix.
    expect(evt?.eventId).toBe("zalopay:260523_def:0");
  });

  it("maps non-order callback types (e.g. type=2 agreement) to payment.failed", () => {
    const evt = adapter.parseWebhookPayload(
      buildCallbackBody({ app_id: 2553, app_trans_id: "260523_ghi", amount: 1_000 }, KEY2, 2),
      {},
    );
    expect(evt?.type).toBe("payment.failed");
  });

  it("returns null on malformed envelope JSON", () => {
    expect(adapter.parseWebhookPayload("not-json", {})).toBeNull();
  });

  it("returns null when the inner data field is not JSON", () => {
    const raw = JSON.stringify({ data: "not-json", mac: signWithKey2("not-json", KEY2) });
    expect(adapter.parseWebhookPayload(raw, {})).toBeNull();
  });

  it("returns null when app_trans_id is missing or empty", () => {
    expect(adapter.parseWebhookPayload(buildCallbackBody({ amount: 1_000 }), {})).toBeNull();
    expect(
      adapter.parseWebhookPayload(buildCallbackBody({ app_trans_id: "", amount: 1_000 }), {}),
    ).toBeNull();
  });

  it("handles zero-amount callbacks without throwing", () => {
    const evt = adapter.parseWebhookPayload(
      buildCallbackBody({ app_trans_id: "260523_zero", amount: 0 }),
      {},
    );
    expect(evt?.amountMicros).toBe("0");
  });
});

describe("refund — 2-step (return_code 1/3/2)", () => {
  const refundInput = {
    transactionId: "tx-1",
    amountMicros: 100_000_000_000n, // 100,000 VND
    idempotencyKey: "idem-1",
    reason: "customer request",
    providerRef: "220101000000123", // zp_trans_id
  };

  it("return_code=1 → completed with providerRefundId", async () => {
    const { calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ return_code: 1, refund_id: "2553_refund_9" }),
    }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("completed");
    expect(result.providerRefundId).toBe("2553_refund_9");
    expect(calls[0]?.url).toBe("https://sb-openapi.zalopay.vn/v2/refund");

    const body = JSON.parse(calls[0]?.body ?? "{}");
    // Refund keys on zp_trans_id (passed via providerRef), not app_trans_id.
    expect(body.zp_trans_id).toBe("220101000000123");
    expect(body.m_refund_id).toBe("idem-1");
    expect(body.amount).toBe(100_000);
    expect(body.description).toBe("customer request");
  });

  it("return_code=3 (PROCESSING) → pending so the server can queue reconciliation", async () => {
    mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ return_code: 3, refund_id: "2553_refund_10" }),
    }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("pending");
    expect(result.providerRefundId).toBe("2553_refund_10");
  });

  it("return_code=2 → failed with provider code and message", async () => {
    mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ return_code: 2, return_message: "Refund window exceeded" }),
    }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("2");
    expect(result.error?.message).toBe("Refund window exceeded");
  });

  it("unknown return_code → failed with fallback message", async () => {
    mockFetch(() => ({ status: 200, body: JSON.stringify({ return_code: -1 }) }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("-1");
    expect(result.error?.message).toBe("ZaloPay refund failed");
  });

  it("omits providerRefundId when ZaloPay returns none", async () => {
    mockFetch(() => ({ status: 200, body: JSON.stringify({ return_code: 1 }) }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("completed");
    expect(result.providerRefundId).toBeUndefined();
  });

  it("signs the refund body with key1", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: JSON.stringify({ return_code: 1 }) }));
    const adapter = createZaloPayAdapter(baseConfig);
    await adapter.refund(refundInput);

    const body = JSON.parse(calls[0]?.body ?? "{}");
    const canonical = [
      baseConfig.appId,
      body.zp_trans_id,
      String(body.amount),
      body.description,
      String(body.timestamp),
    ].join("|");
    expect(body.mac).toBe(signWithKey1(canonical, KEY1));
  });

  it("missing providerRef → failed MISSING_ZP_TRANS_ID with no network call", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: JSON.stringify({ return_code: 1 }) }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 100_000_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
    });

    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_ZP_TRANS_ID");
    expect(calls).toHaveLength(0);
  });

  it("empty-string providerRef is treated as missing", async () => {
    mockFetch(() => ({ status: 200, body: JSON.stringify({ return_code: 1 }) }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund({ ...refundInput, providerRef: "" });

    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_ZP_TRANS_ID");
  });

  it("non-2xx HTTP → failed with HTTP_<status>", async () => {
    mockFetch(() => ({ status: 502, body: "bad gateway" }));
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("HTTP_502");
  });

  it("network error → failed NETWORK_ERROR (never throws to the caller)", async () => {
    mockFetchThrows("ECONNRESET");
    const adapter = createZaloPayAdapter(baseConfig);
    const result = await adapter.refund(refundInput);

    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("NETWORK_ERROR");
    expect(result.error?.message).toBe("ECONNRESET");
  });

  it("uses production refund host when environment='production'", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: JSON.stringify({ return_code: 1 }) }));
    const adapter = createZaloPayAdapter({ ...baseConfig, environment: "production" });
    await adapter.refund(refundInput);

    expect(calls[0]?.url).toBe("https://openapi.zalopay.vn/v2/refund");
  });
});
