import { createJwtSecretLoader } from "@vibecc/paykit-server";
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

  it("leaves a VN provider undefined when any required cred is missing", async () => {
    const env = {
      DATABASE_URL: "postgres://localhost/paykit",
      // VNPay missing IPN URL → must not enable
      VNPAY_TMN_CODE: "TMN1",
      VNPAY_HASH_SECRET: "vnp-secret",
      VNPAY_RETURN_URL: "https://app/return",
    };
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
