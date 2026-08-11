/**
 * VN adapter wiring tests — buildAdaptersFromConfig must enable VNPay/Momo/
 * ZaloPay when their creds are present and skip them otherwise, without
 * touching the existing Stripe/SePay/NowPayments blocks.
 *
 * Asserts by adapter id (vnpay/momo/zalopay) on the real factory output so the
 * config→factory field mapping is exercised end-to-end.
 */
import { describe, expect, it } from "vitest";
import { buildAdaptersFromConfig } from "../src/adapters-from-env.js";
import type { ServiceConfig } from "../src/config.js";

// Every provider field is listed explicitly, including the ones this file does
// not exercise. The type allows `undefined` per field, so an omission compiles
// here (tests are outside tsc's include) and silently drops whichever provider
// was forgotten from the "no creds present" baseline below.
const base: ServiceConfig = {
  databaseUrl: "postgres://localhost/paykit",
  port: 3000,
  stripe: undefined,
  sepay: undefined,
  nowpayments: undefined,
  cryptomus: undefined,
  binance: undefined,
  coinbaseCommerce: undefined,
  vnpay: undefined,
  momo: undefined,
  zalopay: undefined,
  adminSecret: undefined,
};

describe("buildAdaptersFromConfig — VN providers", () => {
  it("wires no adapters when no creds present", async () => {
    const adapters = await buildAdaptersFromConfig(base);
    expect(adapters).toHaveLength(0);
  });

  it("wires the vnpay adapter when vnpay creds present", async () => {
    const adapters = await buildAdaptersFromConfig({
      ...base,
      vnpay: {
        tmnCode: "TMN1",
        hashSecret: "vnp-secret",
        returnUrl: "https://app/return",
        ipnUrl: "https://app/ipn",
        environment: "sandbox",
      },
    });
    expect(adapters.map((a) => a.id)).toContain("vnpay");
  });

  it("wires the momo adapter when momo creds present", async () => {
    const adapters = await buildAdaptersFromConfig({
      ...base,
      momo: {
        partnerCode: "MOMO1",
        accessKey: "ak",
        secretKey: "sk",
        returnUrl: "https://app/return",
        ipnUrl: "https://app/ipn",
        environment: "sandbox",
      },
    });
    expect(adapters.map((a) => a.id)).toContain("momo");
  });

  it("wires the zalopay adapter when zalopay creds present", async () => {
    const adapters = await buildAdaptersFromConfig({
      ...base,
      zalopay: {
        appId: "123",
        key1: "k1",
        key2: "k2",
        returnUrl: "https://app/return",
        callbackUrl: "https://app/cb",
        environment: "sandbox",
      },
    });
    expect(adapters.map((a) => a.id)).toContain("zalopay");
  });

  it("wires all three VN adapters together", async () => {
    const adapters = await buildAdaptersFromConfig({
      ...base,
      vnpay: {
        tmnCode: "TMN1",
        hashSecret: "vnp-secret",
        returnUrl: "https://app/return",
        ipnUrl: "https://app/ipn",
        environment: "sandbox",
      },
      momo: {
        partnerCode: "MOMO1",
        accessKey: "ak",
        secretKey: "sk",
        returnUrl: "https://app/return",
        ipnUrl: "https://app/ipn",
        environment: "sandbox",
      },
      zalopay: {
        appId: "123",
        key1: "k1",
        key2: "k2",
        returnUrl: "https://app/return",
        callbackUrl: "https://app/cb",
        environment: "sandbox",
      },
    });
    const ids = adapters.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["vnpay", "momo", "zalopay"]));
    expect(ids).toHaveLength(3);
  });
});

describe("buildAdaptersFromConfig — Coinbase Commerce", () => {
  it("wires the adapter when the api key and webhook secret are present", async () => {
    const adapters = await buildAdaptersFromConfig({
      ...base,
      coinbaseCommerce: { apiKey: "cc-key", webhookSecret: "whsec" },
    });
    // Asserted by id because a provider can be resolved in config and still never
    // reach the registry if the wiring block is missing.
    expect(adapters.map((a) => a.id)).toContain("coinbase-commerce");
  });

  it("prices in USD and reports refunds as unsupported by the provider", async () => {
    const [adapter] = await buildAdaptersFromConfig({
      ...base,
      coinbaseCommerce: { apiKey: "cc-key", webhookSecret: "whsec" },
    });
    expect(adapter?.supportedCurrencies).toEqual(["USD"]);
    const refund = await adapter?.refund({
      transactionId: "tx-1",
      amountMicros: 1_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "tx-1",
    });
    expect(refund?.state).toBe("unsupported");
  });

  it("skips the adapter when no coinbase creds are present", async () => {
    const adapters = await buildAdaptersFromConfig(base);
    expect(adapters.map((a) => a.id)).not.toContain("coinbase-commerce");
  });
});
