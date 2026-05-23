import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSepayAdapter } from "../src/adapter.js";

const baseConfig = {
  apiKey: "ak",
  secretKey: "secret_test",
  accountNumber: "0123456789",
  accountName: "PAYKIT TEST",
  bankBin: "970422",
};

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("createSepayAdapter — adapter contract", () => {
  const adapter = createSepayAdapter(baseConfig);

  it("id defaults to 'sepay'", () => {
    expect(adapter.id).toBe("sepay");
  });

  it("supportedCurrencies = ['VND']", () => {
    expect(adapter.supportedCurrencies).toEqual(["VND"]);
  });

  it("checkoutMode = 'qr'", () => {
    expect(adapter.checkoutMode).toBe("qr");
  });
});

describe("createSepayAdapter — createCheckout", () => {
  it("converts VND-native micros to VND for VietQR URL", async () => {
    const adapter = createSepayAdapter(baseConfig);
    const result = await adapter.createCheckout({
      transactionId: "abc-123",
      tenantId: "t-1",
      ownerId: "o-1",
      amountMicros: 100_000_000_000n, // 100,000 VND
      currencyCode: "VND",
    });
    expect(result.qrUrl).toContain("amount=100000");
    expect(result.qrUrl).toContain(baseConfig.bankBin);
    expect(result.qrUrl).toContain("addInfo=PAYKIT%20abc-123");
    expect(result.webUrl).toBe(result.qrUrl);
  });

  it("rejects non-VND currency", async () => {
    const adapter = createSepayAdapter(baseConfig);
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

  it("custom brandPrefix changes addInfo", async () => {
    const adapter = createSepayAdapter({ ...baseConfig, brandPrefix: "MYAPP" });
    const result = await adapter.createCheckout({
      transactionId: "x-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000n,
      currencyCode: "VND",
    });
    expect(result.qrUrl).toContain("addInfo=MYAPP%20x-1");
  });
});

describe("createSepayAdapter — webhook signature", () => {
  it("verifies with single secret string", () => {
    const adapter = createSepayAdapter(baseConfig);
    const payload = JSON.stringify({
      id: "evt-1",
      transferType: "in",
      transferAmount: 100000,
      content: "PAYKIT abc-123",
      description: "",
      referenceCode: "ref-1",
    });
    expect(
      adapter.verifyWebhookSignature(payload, {
        "x-sepay-signature": sign(payload, "secret_test"),
      }),
    ).toBe(true);
  });

  it("verifies with rotation array", () => {
    const adapter = createSepayAdapter({
      ...baseConfig,
      secretKey: ["secret_old", "secret_new"],
    });
    const payload = JSON.stringify({ id: "evt-1", transferType: "in" });
    expect(
      adapter.verifyWebhookSignature(payload, {
        "x-sepay-signature": sign(payload, "secret_old"),
      }),
    ).toBe(true);
  });

  it("rejects bad signature", () => {
    const adapter = createSepayAdapter(baseConfig);
    expect(adapter.verifyWebhookSignature("payload", { "x-sepay-signature": "bad" })).toBe(false);
  });
});

describe("createSepayAdapter — parseWebhookPayload", () => {
  const adapter = createSepayAdapter(baseConfig);

  it("transferType='in' with valid orderId → payment.completed", () => {
    const payload = JSON.stringify({
      id: "evt-1",
      transferType: "in",
      transferAmount: 100000,
      content: "PAYKIT abc-123",
      description: "",
      referenceCode: "ref-1",
    });
    const result = adapter.parseWebhookPayload(payload, {});
    expect(result?.type).toBe("payment.completed");
    expect(result?.providerRef).toBe("abc-123");
    expect(result?.amountMicros).toBe("100000000000"); // 100,000 × 1M micros
    expect(result?.currencyCode).toBe("VND");
  });

  it("transferType='out' → null (skip outgoing)", () => {
    const payload = JSON.stringify({
      id: "evt-2",
      transferType: "out",
      transferAmount: 50000,
      content: "PAYKIT xyz",
      description: "",
      referenceCode: "ref-2",
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("missing orderId in content → null (skip unmatched)", () => {
    const payload = JSON.stringify({
      id: "evt-3",
      transferType: "in",
      transferAmount: 1000,
      content: "random transfer note",
      description: "",
      referenceCode: "ref-3",
    });
    expect(adapter.parseWebhookPayload(payload, {})).toBeNull();
  });

  it("malformed JSON → null", () => {
    expect(adapter.parseWebhookPayload("not-json", {})).toBeNull();
  });
});

describe("createSepayAdapter — refund", () => {
  it("returns state='unsupported' with pointer to /admin/billing/ledger/adjust", async () => {
    const adapter = createSepayAdapter(baseConfig);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 1_000_000n,
      idempotencyKey: "key-1",
      reason: "customer dispute",
    });
    expect(result.state).toBe("unsupported");
    expect(result.error?.providerCode).toBe("SEPAY_REFUND_UNSUPPORTED");
    expect(result.error?.message).toContain("ledger/adjust");
  });
});

describe("createSepayAdapter — fetchTransactions", () => {
  it("returns [] when no transactionFetcher provided", async () => {
    const adapter = createSepayAdapter(baseConfig);
    expect(await adapter.fetchTransactions({ since: new Date() })).toEqual([]);
  });

  it("converts VND amounts to micros via fetcher", async () => {
    const adapter = createSepayAdapter({
      ...baseConfig,
      transactionFetcher: async () => [
        { id: "evt-1", orderId: "order-A", transferAmount: 100_000 },
      ],
    });
    const result = await adapter.fetchTransactions({ since: new Date() });
    expect(result).toHaveLength(1);
    expect(result[0]?.providerRef).toBe("order-A");
    expect(result[0]?.amountMicros).toBe("100000000000");
    expect(result[0]?.currencyCode).toBe("VND");
  });
});
