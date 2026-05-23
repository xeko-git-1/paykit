import { describe, expect, it, vi } from "vitest";
import { createMomoAdapter } from "../src/adapter.js";

const baseConfig = {
  partnerCode: "MOMOTEST",
  accessKey: "ak_test",
  secretKey: "secret_test",
  returnUrl: "https://app.example/return",
  ipnUrl: "https://app.example/ipn",
};

describe("createMomoAdapter — adapter contract", () => {
  const adapter = createMomoAdapter(baseConfig);

  it("id defaults to 'momo'", () => {
    expect(adapter.id).toBe("momo");
  });

  it("supportedCurrencies = ['VND']", () => {
    expect(adapter.supportedCurrencies).toEqual(["VND"]);
  });

  it("checkoutMode = 'redirect' (with deeplink in CheckoutResult)", () => {
    expect(adapter.checkoutMode).toBe("redirect");
  });

  it("displayName = 'MoMo'", () => {
    expect(adapter.displayName).toBe("MoMo");
  });
});

describe("createMomoAdapter — refund without transId", () => {
  it("returns failed state with MISSING_TRANS_ID error", async () => {
    const adapter = createMomoAdapter(baseConfig);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 1_000_000_000n,
      idempotencyKey: "key-1",
      reason: "test",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_TRANS_ID");
  });
});

describe("createMomoAdapter — parseWebhookPayload", () => {
  const adapter = createMomoAdapter(baseConfig);

  it("resultCode=0 → payment.completed", () => {
    const payload = JSON.stringify({
      partnerCode: "MOMOTEST",
      orderId: "tx-1",
      requestId: "req-1",
      amount: "100000",
      resultCode: 0,
      transId: "trans-99",
      signature: "ignored-here",
    });
    const result = adapter.parseWebhookPayload(payload, {});
    expect(result?.type).toBe("payment.completed");
    expect(result?.providerRef).toBe("tx-1");
    expect(result?.amountMicros).toBe("100000000000");
    expect(result?.currencyCode).toBe("VND");
  });

  it("resultCode=1006 (user cancelled) → null", () => {
    const payload = JSON.stringify({
      orderId: "tx-2",
      amount: "100000",
      resultCode: 1006,
      requestId: "req-2",
      partnerCode: "x",
      signature: "x",
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("other resultCode → payment.failed", () => {
    const payload = JSON.stringify({
      orderId: "tx-3",
      amount: "100000",
      resultCode: 9000,
      requestId: "req-3",
      partnerCode: "x",
      signature: "x",
    });
    const result = adapter.parseWebhookPayload(payload, {});
    expect(result?.type).toBe("payment.failed");
    expect((result?.metadata as { resultCode?: number })?.resultCode).toBe(9000);
  });

  it("missing orderId → null", () => {
    const payload = JSON.stringify({
      amount: "100000",
      resultCode: 0,
      requestId: "req-4",
      partnerCode: "x",
      signature: "x",
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("malformed JSON → null", () => {
    expect(adapter.parseWebhookPayload("not-json", {})).toBeNull();
  });
});

describe("createMomoAdapter — environment toggle", () => {
  it("sandbox is default; refund URL points to test-payment.momo.vn", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resultCode: 0, transId: "ref-1" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = createMomoAdapter(baseConfig);
    await adapter.refund({
      transactionId: "tx-1",
      providerRef: "trans-99",
      amountMicros: 1_000_000_000n,
      idempotencyKey: "key-1",
      reason: "test",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("test-payment.momo.vn");
  });

  it("environment='production' uses payment.momo.vn", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resultCode: 0, transId: "ref-1" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = createMomoAdapter({ ...baseConfig, environment: "production" });
    await adapter.refund({
      transactionId: "tx-1",
      providerRef: "trans-99",
      amountMicros: 1_000_000_000n,
      idempotencyKey: "key-1",
      reason: "test",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("payment.momo.vn");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("test-payment.momo.vn");
  });
});
