import { describe, expect, it } from "vitest";
import { createVnpayAdapter } from "../src/adapter.js";

const baseConfig = {
  tmnCode: "TEST_TMN",
  hashSecret: "test_secret",
  returnUrl: "https://app.example/return",
  ipnUrl: "https://app.example/ipn",
};

describe("createVnpayAdapter — adapter contract", () => {
  const adapter = createVnpayAdapter(baseConfig);

  it("id defaults to 'vnpay'", () => {
    expect(adapter.id).toBe("vnpay");
  });

  it("supports multi-instance via id config", () => {
    const eu = createVnpayAdapter({ ...baseConfig, id: "vnpay:fallback" });
    expect(eu.id).toBe("vnpay:fallback");
  });

  it("supportedCurrencies = ['VND']", () => {
    expect(adapter.supportedCurrencies).toEqual(["VND"]);
  });

  it("checkoutMode = 'redirect'", () => {
    expect(adapter.checkoutMode).toBe("redirect");
  });
});

describe("createVnpayAdapter — createCheckout", () => {
  it("builds signed redirect URL with vnp_Amount × 100", async () => {
    const adapter = createVnpayAdapter(baseConfig);
    const result = await adapter.createCheckout({
      transactionId: "tx-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 100_000_000_000n, // 100,000 VND
      currencyCode: "VND",
    });
    // 100,000 VND × 100 = 10,000,000
    expect(result.webUrl).toContain("vnp_Amount=10000000");
    expect(result.webUrl).toContain("vnp_TxnRef=tx-1");
    expect(result.webUrl).toContain("vnp_TmnCode=TEST_TMN");
    expect(result.webUrl).toContain("vnp_SecureHash=");
  });

  it("uses sandbox URL by default", async () => {
    const adapter = createVnpayAdapter(baseConfig);
    const result = await adapter.createCheckout({
      transactionId: "tx-x",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000_000n,
      currencyCode: "VND",
    });
    expect(result.webUrl).toContain("sandbox.vnpayment.vn");
  });

  it("uses production URL when environment='production'", async () => {
    const adapter = createVnpayAdapter({ ...baseConfig, environment: "production" });
    const result = await adapter.createCheckout({
      transactionId: "tx-x",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000_000n,
      currencyCode: "VND",
    });
    expect(result.webUrl).toContain("vnpayment.vn");
    expect(result.webUrl).not.toContain("sandbox.vnpayment.vn");
  });

  it("rejects non-VND currency", async () => {
    const adapter = createVnpayAdapter(baseConfig);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-x",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/VND only/);
  });

  it("includes returnUrl from input over config default", async () => {
    const adapter = createVnpayAdapter(baseConfig);
    const result = await adapter.createCheckout({
      transactionId: "tx-x",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000_000n,
      currencyCode: "VND",
      returnUrl: "https://app.example/custom-return",
    });
    expect(decodeURIComponent(result.webUrl)).toContain("https://app.example/custom-return");
  });

  it("checkoutMode='redirect' returns no qrUrl or mobileDeeplink", async () => {
    const adapter = createVnpayAdapter(baseConfig);
    const result = await adapter.createCheckout({
      transactionId: "tx-x",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000_000n,
      currencyCode: "VND",
    });
    expect(result.qrUrl).toBeUndefined();
    expect(result.mobileDeeplink).toBeUndefined();
  });
});

describe("createVnpayAdapter — fetchTransactions", () => {
  it("returns [] (VNPay has no list-by-window API in V1.5)", async () => {
    const adapter = createVnpayAdapter(baseConfig);
    expect(await adapter.fetchTransactions({ since: new Date() })).toEqual([]);
  });
});
