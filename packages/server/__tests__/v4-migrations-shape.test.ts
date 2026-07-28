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
const m014Up = readFileSync(resolve(MIGRATIONS_DIR, "014_api_keys_created_by.up.sql"), "utf8");
const m014Down = readFileSync(resolve(MIGRATIONS_DIR, "014_api_keys_created_by.down.sql"), "utf8");
const m018Up = readFileSync(resolve(MIGRATIONS_DIR, "018_provider_payment_id.up.sql"), "utf8");
const m018Down = readFileSync(resolve(MIGRATIONS_DIR, "018_provider_payment_id.down.sql"), "utf8");

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
    const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
    expect(ids.length).toBeGreaterThanOrEqual(12);
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });
});

describe("V4.0 migration 014_api_keys_created_by", () => {
  it("up adds created_by column to api_keys (ALTER, not a new table)", () => {
    expect(m014Up).toMatch(/ALTER TABLE paykit\.api_keys\s+ADD COLUMN created_by/i);
    // No CREATE TABLE — table count stays at 13 (this is an attribution column only)
    expect(m014Up).not.toMatch(/CREATE TABLE/i);
  });

  it("created_by is nullable (no NOT NULL, no DEFAULT) — safe on populated table", () => {
    expect(m014Up).not.toMatch(/created_by\s+TEXT\s+NOT NULL/i);
    expect(m014Up).not.toMatch(/created_by\s+TEXT\s+DEFAULT/i);
  });

  it("down drops the created_by column", () => {
    expect(m014Down).toMatch(/ALTER TABLE paykit\.api_keys\s+DROP COLUMN IF EXISTS created_by/i);
  });

  it("manifest entry 014 points to correct filenames", () => {
    const entry = manifest.migrations.find((m) => m.id === "014");
    expect(entry).toBeDefined();
    expect(entry!.slug).toBe("api_keys_created_by");
    expect(entry!.up).toBe("014_api_keys_created_by.up.sql");
    expect(entry!.down).toBe("014_api_keys_created_by.down.sql");
  });
});

describe("migration 018_provider_payment_id", () => {
  it("up adds nullable provider_payment_id column to payment_transactions (ALTER, not a new table)", () => {
    expect(m018Up).toMatch(
      /ALTER TABLE paykit\.payment_transactions\s+ADD COLUMN provider_payment_id/i,
    );
    expect(m018Up).not.toMatch(/CREATE TABLE/i);
    // Nullable so it is safe to add on a populated table (most providers never set it)
    expect(m018Up).not.toMatch(/provider_payment_id\s+text\s+NOT NULL/i);
  });

  it("down drops the provider_payment_id column", () => {
    expect(m018Down).toMatch(
      /ALTER TABLE paykit\.payment_transactions\s+DROP COLUMN IF EXISTS provider_payment_id/i,
    );
  });

  it("manifest entry 018 points to correct filenames", () => {
    const entry = manifest.migrations.find((m) => m.id === "018");
    expect(entry).toBeDefined();
    expect(entry!.slug).toBe("provider_payment_id");
    expect(entry!.up).toBe("018_provider_payment_id.up.sql");
    expect(entry!.down).toBe("018_provider_payment_id.down.sql");
  });
});
