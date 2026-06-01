import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const m012Up = readFileSync(resolve(MIGRATIONS_DIR, "012_merchants_and_api_keys.up.sql"), "utf8");
const m012Down = readFileSync(
  resolve(MIGRATIONS_DIR, "012_merchants_and_api_keys.down.sql"),
  "utf8",
);
const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8")) as {
  migrations: { id: string; slug: string; up: string; down: string; description: string }[];
};

describe("V4 migration 012_merchants_and_api_keys — up", () => {
  it("creates paykit.merchants table", () => {
    expect(m012Up).toMatch(/CREATE TABLE paykit\.merchants/);
  });

  it("creates paykit.api_keys table", () => {
    expect(m012Up).toMatch(/CREATE TABLE paykit\.api_keys/);
  });

  it("api_keys.key_hash is UNIQUE", () => {
    expect(m012Up).toMatch(/key_hash\s+TEXT NOT NULL UNIQUE/);
  });

  it("api_keys.merchant_id has FK to merchants with ON DELETE RESTRICT", () => {
    expect(m012Up).toMatch(/REFERENCES paykit\.merchants\s*\(merchant_id\)/);
    expect(m012Up).toMatch(/ON DELETE RESTRICT/);
  });

  it("merchants.status has CHECK constraint (active|suspended)", () => {
    expect(m012Up).toMatch(/CHECK\s*\(status IN \('active', 'suspended'\)\)/);
  });

  it("api_keys.mode has CHECK constraint (live|test)", () => {
    expect(m012Up).toMatch(/CHECK\s*\(mode IN \('live', 'test'\)\)/);
  });

  it("creates index on api_keys(key_hash) for verify lookup", () => {
    expect(m012Up).toMatch(/CREATE.*INDEX.*ON paykit\.api_keys\s*\(key_hash\)/);
  });

  it("creates index on api_keys(merchant_id)", () => {
    expect(m012Up).toMatch(/CREATE.*INDEX.*ON paykit\.api_keys\s*\(merchant_id\)/);
  });
});

describe("V4 migration 012_merchants_and_api_keys — down (rename-not-drop)", () => {
  it("renames tables to quarantine instead of dropping", () => {
    expect(m012Down).toMatch(/ALTER TABLE.*RENAME TO/);
    expect(m012Down).toMatch(/quarantine/i);
  });

  it("does NOT contain DROP TABLE for merchants", () => {
    expect(m012Down).not.toMatch(/DROP TABLE.*merchants/i);
  });

  it("does NOT contain DROP TABLE for api_keys", () => {
    expect(m012Down).not.toMatch(/DROP TABLE.*api_keys/i);
  });
});

describe("V4 manifest entry 012", () => {
  it("manifest has entry with id 012", () => {
    const entry = manifest.migrations.find((m) => m.id === "012");
    expect(entry).toBeDefined();
    expect(entry!.slug).toBe("merchants_and_api_keys");
  });

  it("manifest 012 entry points to correct filenames", () => {
    const entry = manifest.migrations.find((m) => m.id === "012");
    expect(entry).toBeDefined();
    expect(entry!.up).toBe("012_merchants_and_api_keys.up.sql");
    expect(entry!.down).toBe("012_merchants_and_api_keys.down.sql");
  });

  it("manifest ids are ascending and contiguous up to at least 012 (no gaps)", () => {
    const ids = manifest.migrations.map((m) => parseInt(m.id, 10));
    expect(ids.length).toBeGreaterThanOrEqual(12);
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });
});
