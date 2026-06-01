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

const base: ServiceConfig = {
  databaseUrl: "postgres://localhost/paykit",
  port: 3000,
  stripe: undefined,
  sepay: undefined,
  nowpayments: undefined,
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
