import { createJwtSecretLoader } from "@xeko-git-1/paykit-server";
/**
 * Config validation tests — verifies fail-fast behavior for missing/invalid env.
 * Also exercises createJwtSecretLoader (the real runtime path) including the
 * race-safe atomic-claim seed behavior.
 */
import { describe, expect, it, vi } from "vitest";

describe("parseServiceConfig", () => {
  it("throws when DATABASE_URL is missing", async () => {
    const env = { PORT: "3000" };
    const { parseServiceConfig } = await import("../src/config.js");
    expect(() => parseServiceConfig(env)).toThrow(/DATABASE_URL/i);
  });

  it("parses valid env without echoing secrets in error", async () => {
    const env = {
      DATABASE_URL: "postgres://user:pass@localhost:5432/paykit",
      PORT: "4000",
    };
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(env);
    expect(config.databaseUrl).toBe(env.DATABASE_URL);
    expect(config.port).toBe(4000);
  });

  it("defaults PORT to 3000 when not provided", async () => {
    const env = { DATABASE_URL: "postgres://localhost/paykit" };
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(env);
    expect(config.port).toBe(3000);
  });

  it("does NOT read PAYKIT_JWT_SECRET from env — secret comes from runtime_config", async () => {
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      PAYKIT_JWT_SECRET: "should-be-ignored",
    };
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(env);
    // Config should not have a jwtSecret field from env
    expect((config as Record<string, unknown>).jwtSecret).toBeUndefined();
  });

  it("enables vnpay/momo/zalopay when all of each provider's creds are present", async () => {
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      VNPAY_TMN_CODE: "TMN1",
      VNPAY_HASH_SECRET: "vnp-secret",
      VNPAY_RETURN_URL: "https://app/return",
      VNPAY_IPN_URL: "https://app/ipn",
      MOMO_PARTNER_CODE: "MOMO1",
      MOMO_ACCESS_KEY: "ak",
      MOMO_SECRET_KEY: "sk",
      MOMO_RETURN_URL: "https://app/return",
      MOMO_IPN_URL: "https://app/ipn",
      ZALOPAY_APP_ID: "123",
      ZALOPAY_KEY1: "k1",
      ZALOPAY_KEY2: "k2",
      ZALOPAY_RETURN_URL: "https://app/return",
      ZALOPAY_CALLBACK_URL: "https://app/cb",
    };
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(env);
    expect(config.vnpay).toEqual({
      tmnCode: "TMN1",
      hashSecret: "vnp-secret",
      returnUrl: "https://app/return",
      ipnUrl: "https://app/ipn",
      environment: "sandbox",
    });
    expect(config.momo?.partnerCode).toBe("MOMO1");
    expect(config.zalopay?.callbackUrl).toBe("https://app/cb");
  });

  it("fails fast when a VN provider has some but not all required creds", async () => {
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      // VNPay missing IPN URL → misconfigured, must not silently disable
      VNPAY_TMN_CODE: "TMN1",
      VNPAY_HASH_SECRET: "vnp-secret",
      VNPAY_RETURN_URL: "https://app/return",
    };
    const { parseServiceConfig } = await import("../src/config.js");
    expect(() => parseServiceConfig(env)).toThrow(/Incomplete VNPay/i);
  });

  it("leaves VN providers undefined when none of their creds are set", async () => {
    const env = { DATABASE_URL: "postgres://localhost/paykit" };
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(env);
    expect(config.vnpay).toBeUndefined();
    expect(config.momo).toBeUndefined();
    expect(config.zalopay).toBeUndefined();
  });

  it("honors explicit VN environment override (production)", async () => {
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      VNPAY_TMN_CODE: "TMN1",
      VNPAY_HASH_SECRET: "vnp-secret",
      VNPAY_RETURN_URL: "https://app/return",
      VNPAY_IPN_URL: "https://app/ipn",
      VNPAY_ENVIRONMENT: "production",
    };
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(env);
    expect(config.vnpay?.environment).toBe("production");
  });

  it("fails fast when a provider has some but not all required creds", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    // Stripe secret present, webhook secret missing → misconfigured deploy.
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      STRIPE_SECRET_KEY: "sk_test_abc",
    };
    expect(() => parseServiceConfig(env)).toThrow(/Incomplete Stripe/i);
  });

  it("names the missing field(s) but never echoes the present secret value", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      SEPAY_API_KEY: "super-secret-value",
      SEPAY_SECRET_KEY: "another-secret",
      // missing SEPAY_ACCOUNT_NUMBER, SEPAY_ACCOUNT_NAME, SEPAY_BANK_BIN
    };
    try {
      parseServiceConfig(env);
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/SEPAY_ACCOUNT_NUMBER/);
      expect(msg).not.toContain("super-secret-value");
    }
  });

  it("does NOT throw when a provider has none of its creds (provider just disabled)", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = { DATABASE_URL: "postgres://localhost/paykit" };
    const config = parseServiceConfig(env);
    expect(config.stripe).toBeUndefined();
    expect(config.sepay).toBeUndefined();
    expect(config.nowpayments).toBeUndefined();
  });

  it("leaves nowpayments.payCurrency unset so the customer picks any USDT chain", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      NOWPAYMENTS_API_KEY: "np-key",
      NOWPAYMENTS_IPN_SECRET: "np-secret",
    };
    const config = parseServiceConfig(env);
    expect(config.nowpayments?.payCurrency).toBeUndefined();
  });

  it("forces a single USDT chain when NOWPAYMENTS_PAY_CURRENCY is set (BEP20)", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      NOWPAYMENTS_API_KEY: "np-key",
      NOWPAYMENTS_IPN_SECRET: "np-secret",
      NOWPAYMENTS_PAY_CURRENCY: "usdtbsc",
    };
    const config = parseServiceConfig(env);
    expect(config.nowpayments?.payCurrency).toBe("usdtbsc");
  });

  it("enables cryptomus when merchant id + payment api key are present", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      CRYPTOMUS_MERCHANT_ID: "merchant-uuid",
      CRYPTOMUS_PAYMENT_API_KEY: "cm-key",
    };
    const config = parseServiceConfig(env);
    expect(config.cryptomus?.merchantId).toBe("merchant-uuid");
    expect(config.cryptomus?.paymentApiKey).toBe("cm-key");
    // Optional chain pin left unset → customer picks any USDT chain.
    expect(config.cryptomus?.network).toBeUndefined();
  });

  it("pins the cryptomus chain when CRYPTOMUS_NETWORK is set (BEP20)", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      CRYPTOMUS_MERCHANT_ID: "merchant-uuid",
      CRYPTOMUS_PAYMENT_API_KEY: "cm-key",
      CRYPTOMUS_NETWORK: "bsc",
      CRYPTOMUS_TO_CURRENCY: "USDT",
    };
    const config = parseServiceConfig(env);
    expect(config.cryptomus?.network).toBe("bsc");
    expect(config.cryptomus?.toCurrency).toBe("USDT");
  });

  it("fails fast when cryptomus has merchant id but no payment api key", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      CRYPTOMUS_MERCHANT_ID: "merchant-uuid",
    };
    expect(() => parseServiceConfig(env)).toThrow(/Incomplete Cryptomus/i);
  });
});

describe("coin/chain code guard", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/paykit",
    NOWPAYMENTS_API_KEY: "np-key",
    NOWPAYMENTS_IPN_SECRET: "np-secret",
  };

  it("refuses to boot on the token-standard spelling of a suffix-named chain", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    // 'usdtbep20' would otherwise boot cleanly and then fail every checkout as a
    // 502 advising a retry that can never succeed.
    const env = { ...base, NOWPAYMENTS_PAY_CURRENCY: "usdtbep20" };
    expect(() => parseServiceConfig(env)).toThrow(/NOWPAYMENTS_PAY_CURRENCY/);
  });

  it("names the value, the known set, and the override in the failure", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = { ...base, NOWPAYMENTS_PAY_CURRENCY: "bep20" };
    expect(() => parseServiceConfig(env)).toThrow(/bep20/);
    expect(() => parseServiceConfig(env)).toThrow(/usdtbsc/);
    expect(() => parseServiceConfig(env)).toThrow(/PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES/);
  });

  it("rejects an unknown cryptomus network and coin", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const cryptomusBase = {
      DATABASE_URL: "postgres://localhost/paykit",
      CRYPTOMUS_MERCHANT_ID: "merchant-uuid",
      CRYPTOMUS_PAYMENT_API_KEY: "cm-key",
    };
    expect(() => parseServiceConfig({ ...cryptomusBase, CRYPTOMUS_NETWORK: "bep20" })).toThrow(
      /CRYPTOMUS_NETWORK/,
    );
    expect(() => parseServiceConfig({ ...cryptomusBase, CRYPTOMUS_TO_CURRENCY: "TETHER" })).toThrow(
      /CRYPTOMUS_TO_CURRENCY/,
    );
  });

  it("accepts every documented chain pin", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    for (const code of ["usdtbsc", "usdttrc20", "usdterc20", "usdtmatic"]) {
      const config = parseServiceConfig({ ...base, NOWPAYMENTS_PAY_CURRENCY: code });
      expect(config.nowpayments?.payCurrency).toBe(code);
    }
  });

  it("accepts a code in any case without rewriting what the provider receives", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({ ...base, NOWPAYMENTS_PAY_CURRENCY: "USDTBSC" });
    // The guard is case-insensitive but must not normalize: the provider gets
    // exactly what the operator configured.
    expect(config.nowpayments?.payCurrency).toBe("USDTBSC");
  });

  it("passes an unrecognised code through when the override is set", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      ...base,
      NOWPAYMENTS_PAY_CURRENCY: "usdtnewchain",
      PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES: "true",
    };
    const config = parseServiceConfig(env);
    expect(config.nowpayments?.payCurrency).toBe("usdtnewchain");
  });

  it("still rejects when the override is explicitly false", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const env = {
      ...base,
      NOWPAYMENTS_PAY_CURRENCY: "usdtnewchain",
      PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES: "false",
    };
    expect(() => parseServiceConfig(env)).toThrow(/NOWPAYMENTS_PAY_CURRENCY/);
  });

  it("boots when no chain is pinned at all", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig(base);
    expect(config.nowpayments?.payCurrency).toBeUndefined();
  });
});

describe("createJwtSecretLoader (race-safe seed)", () => {
  it("generates and seeds a secret via claimKey when runtime_config has none", async () => {
    const store = new Map<string, string>();
    const deps = {
      getKey: vi.fn(async (_db: unknown, key: string) => {
        const val = store.get(key);
        return val ? { value: val } : undefined;
      }),
      claimKey: vi.fn(async (_db: unknown, input: { key: string; value: string }) => {
        // Simulate atomic claim: first writer wins
        if (!store.has(input.key)) {
          store.set(input.key, input.value);
        }
        return { value: store.get(input.key)! };
      }),
      db: {} as unknown,
    };

    const loader = createJwtSecretLoader(deps);
    const secret = await loader();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(deps.claimKey).toHaveBeenCalledOnce();
  });

  it("returns existing secret when present and >= 32 bytes", async () => {
    const validSecret = "a".repeat(48);
    const deps = {
      getKey: vi.fn(async () => ({ value: validSecret })),
      claimKey: vi.fn(),
      db: {} as unknown,
    };

    const loader = createJwtSecretLoader(deps);
    const secret = await loader();
    expect(secret).toBe(validSecret);
    expect(deps.claimKey).not.toHaveBeenCalled();
  });

  it("throws when existing secret is shorter than 32 bytes", async () => {
    const shortSecret = "short";
    const deps = {
      getKey: vi.fn(async () => ({ value: shortSecret })),
      claimKey: vi.fn(),
      db: {} as unknown,
    };

    const loader = createJwtSecretLoader(deps);
    await expect(loader()).rejects.toThrow(/too short|< 32/i);
  });

  it("converges on the winner's value when another instance races", async () => {
    const winnerSecret = "winner-secret-that-is-at-least-32-bytes-long!!";
    const deps = {
      getKey: vi.fn(async () => undefined),
      // Simulate losing the race: claimKey returns the winner's value, not ours
      claimKey: vi.fn(async () => ({ value: winnerSecret })),
      db: {} as unknown,
    };

    const loader = createJwtSecretLoader(deps);
    const secret = await loader();
    // Must use the winner's value, not the locally generated one
    expect(secret).toBe(winnerSecret);
  });
});

describe("BitPay config", () => {
  it("enables the provider with just the POS token (signer optional)", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({
      DATABASE_URL: "postgres://localhost/paykit",
      BITPAY_API_TOKEN: "pos-token",
    });
    expect(config.bitpay?.apiToken).toBe("pos-token");
    expect(config.bitpay?.environment).toBe("sandbox");
    expect(config.bitpay?.merchantPrivateKey).toBeUndefined();
  });

  it("carries the merchant private key and env override when set", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({
      DATABASE_URL: "postgres://localhost/paykit",
      BITPAY_API_TOKEN: "pos-token",
      BITPAY_ENVIRONMENT: "production",
      BITPAY_MERCHANT_PRIVATE_KEY: "a".repeat(64),
      BITPAY_NOTIFICATION_URL: "https://app/webhooks/bitpay",
      BITPAY_REDIRECT_URL: "https://app/return",
    });
    expect(config.bitpay?.environment).toBe("production");
    expect(config.bitpay?.merchantPrivateKey).toBe("a".repeat(64));
    expect(config.bitpay?.notificationUrl).toBe("https://app/webhooks/bitpay");
    expect(config.bitpay?.redirectUrl).toBe("https://app/return");
  });

  it("leaves the provider disabled when no creds are set", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({ DATABASE_URL: "postgres://localhost/paykit" });
    expect(config.bitpay).toBeUndefined();
  });
});

describe("ApiPay config", () => {
  it("enables the provider when all four creds are present", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({
      DATABASE_URL: "postgres://localhost/paykit",
      APIPAY_ACCESS_KEY: "ak",
      APIPAY_SECRET_KEY: "sk",
      APIPAY_WEBHOOK_SECRET: "whsec",
      APIPAY_BANK_PUBLIC_ID: "bnk_1",
    });
    expect(config.apipay).toEqual({
      accessKey: "ak",
      secretKey: "sk",
      webhookSecret: "whsec",
      bankPublicId: "bnk_1",
    });
  });

  it("fails fast when the webhook secret is missing", async () => {
    // Payment links would be created that no inbound event could ever
    // authenticate, so a paid transfer would never be credited. Better to
    // refuse at boot.
    const { parseServiceConfig } = await import("../src/config.js");
    expect(() =>
      parseServiceConfig({
        DATABASE_URL: "postgres://localhost/paykit",
        APIPAY_ACCESS_KEY: "ak",
        APIPAY_SECRET_KEY: "sk",
        APIPAY_BANK_PUBLIC_ID: "bnk_1",
      }),
    ).toThrow(/Incomplete ApiPay/i);
  });

  it("leaves the provider disabled when no creds are set", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({ DATABASE_URL: "postgres://localhost/paykit" });
    expect(config.apipay).toBeUndefined();
  });
});

describe("Coinbase Commerce config", () => {
  it("enables the provider when the api key and webhook secret are both present", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({
      DATABASE_URL: "postgres://localhost/paykit",
      COINBASE_COMMERCE_API_KEY: "cc-key",
      COINBASE_COMMERCE_WEBHOOK_SECRET: "whsec",
    });
    expect(config.coinbaseCommerce?.apiKey).toBe("cc-key");
    expect(config.coinbaseCommerce?.webhookSecret).toBe("whsec");
  });

  it("fails fast when the webhook secret is missing", async () => {
    // Charges would be created that no inbound event could ever authenticate, so
    // a paid charge would never be credited. Better to refuse at boot.
    const { parseServiceConfig } = await import("../src/config.js");
    expect(() =>
      parseServiceConfig({
        DATABASE_URL: "postgres://localhost/paykit",
        COINBASE_COMMERCE_API_KEY: "cc-key",
      }),
    ).toThrow(/Incomplete Coinbase Commerce/i);
  });

  it("leaves the provider disabled when no creds are set", async () => {
    const { parseServiceConfig } = await import("../src/config.js");
    const config = parseServiceConfig({ DATABASE_URL: "postgres://localhost/paykit" });
    expect(config.coinbaseCommerce).toBeUndefined();
  });
});
