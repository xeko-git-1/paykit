import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/lib/env-loader.js";

describe("loadEnv", () => {
  it("reads --db-url flag with priority", () => {
    const env = loadEnv("postgres://flag");
    expect(env.databaseUrl).toBe("postgres://flag");
  });

  it("falls back to DATABASE_URL_PAYKIT env", () => {
    const original = process.env.DATABASE_URL_PAYKIT;
    process.env.DATABASE_URL_PAYKIT = "postgres://from-env";
    try {
      const env = loadEnv();
      expect(env.databaseUrl).toBe("postgres://from-env");
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL_PAYKIT = original;
      } else {
        // biome-ignore lint/performance/noDelete: env key removal is the only correct way
        delete process.env.DATABASE_URL_PAYKIT;
      }
    }
  });

  it("falls back to DATABASE_URL (standalone service) when paykit-specific vars absent", () => {
    const a = process.env.DATABASE_URL_PAYKIT;
    const b = process.env.PAYKIT_DATABASE_URL;
    const c = process.env.DATABASE_URL;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.DATABASE_URL_PAYKIT;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.PAYKIT_DATABASE_URL;
    process.env.DATABASE_URL = "postgres://standalone";
    try {
      expect(loadEnv().databaseUrl).toBe("postgres://standalone");
    } finally {
      if (a !== undefined) process.env.DATABASE_URL_PAYKIT = a;
      if (b !== undefined) process.env.PAYKIT_DATABASE_URL = b;
      if (c !== undefined) process.env.DATABASE_URL = c;
      else delete process.env.DATABASE_URL;
    }
  });

  it("prefers DATABASE_URL_PAYKIT over DATABASE_URL (embedded must not use app DB)", () => {
    const a = process.env.DATABASE_URL_PAYKIT;
    const c = process.env.DATABASE_URL;
    process.env.DATABASE_URL_PAYKIT = "postgres://paykit-own";
    process.env.DATABASE_URL = "postgres://app-db";
    try {
      expect(loadEnv().databaseUrl).toBe("postgres://paykit-own");
    } finally {
      if (a !== undefined) process.env.DATABASE_URL_PAYKIT = a;
      else delete process.env.DATABASE_URL_PAYKIT;
      if (c !== undefined) process.env.DATABASE_URL = c;
      else delete process.env.DATABASE_URL;
    }
  });

  it("throws with paykit-specific guidance when no source provided", () => {
    const a = process.env.DATABASE_URL_PAYKIT;
    const b = process.env.PAYKIT_DATABASE_URL;
    const c = process.env.DATABASE_URL;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.DATABASE_URL_PAYKIT;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.PAYKIT_DATABASE_URL;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.DATABASE_URL;
    try {
      expect(() => loadEnv()).toThrow(/DATABASE_URL_PAYKIT/);
      expect(() => loadEnv()).toThrow(/Postgres database/i);
    } finally {
      if (a !== undefined) process.env.DATABASE_URL_PAYKIT = a;
      if (b !== undefined) process.env.PAYKIT_DATABASE_URL = b;
      if (c !== undefined) process.env.DATABASE_URL = c;
    }
  });
});
