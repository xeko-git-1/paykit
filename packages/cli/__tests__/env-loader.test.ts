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

  it("throws with paykit-specific guidance when no source provided", () => {
    const a = process.env.DATABASE_URL_PAYKIT;
    const b = process.env.PAYKIT_DATABASE_URL;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.DATABASE_URL_PAYKIT;
    // biome-ignore lint/performance/noDelete: env key removal is the only correct way
    delete process.env.PAYKIT_DATABASE_URL;
    try {
      expect(() => loadEnv()).toThrow(/DATABASE_URL_PAYKIT/);
      expect(() => loadEnv()).toThrow(/Postgres database/i);
    } finally {
      if (a !== undefined) process.env.DATABASE_URL_PAYKIT = a;
      if (b !== undefined) process.env.PAYKIT_DATABASE_URL = b;
    }
  });
});
