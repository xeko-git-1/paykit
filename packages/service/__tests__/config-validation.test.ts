/**
 * Config validation tests — verifies fail-fast behavior for missing/invalid env
 * and JWT secret bootstrap from runtime_config (not env).
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
});

describe("bootstrapJwtSecret", () => {
  it("generates and seeds a secret when runtime_config has none", async () => {
    const { bootstrapJwtSecret } = await import("../src/config.js");
    const store = new Map<string, string>();
    const deps = {
      getKey: vi.fn(async (_db: unknown, key: string) => {
        const val = store.get(key);
        return val ? { value: val } : undefined;
      }),
      setKey: vi.fn(async (_db: unknown, input: { key: string; value: string }) => {
        store.set(input.key, input.value);
        return { value: input.value };
      }),
      db: {} as unknown,
    };

    const secret = await bootstrapJwtSecret(deps);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(deps.setKey).toHaveBeenCalledOnce();
  });

  it("returns existing secret when present and >= 32 bytes", async () => {
    const { bootstrapJwtSecret } = await import("../src/config.js");
    const validSecret = "a".repeat(48); // 48 bytes
    const deps = {
      getKey: vi.fn(async () => ({ value: validSecret })),
      setKey: vi.fn(),
      db: {} as unknown,
    };

    const secret = await bootstrapJwtSecret(deps);
    expect(secret).toBe(validSecret);
    expect(deps.setKey).not.toHaveBeenCalled();
  });

  it("throws when existing secret is shorter than 32 bytes", async () => {
    const { bootstrapJwtSecret } = await import("../src/config.js");
    const shortSecret = "short";
    const deps = {
      getKey: vi.fn(async () => ({ value: shortSecret })),
      setKey: vi.fn(),
      db: {} as unknown,
    };

    await expect(bootstrapJwtSecret(deps)).rejects.toThrow(/too short|< 32/i);
  });
});
