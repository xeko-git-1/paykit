/**
 * Migration 016 shape test — discounts.
 *
 * Verifies the table/columns/constraints and manifest registration (root + CLI
 * mirror) for the tenant-scoped promo-code table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "016_discounts.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "016_discounts.down.sql"), "utf8");
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as { migrations: { id: string; slug: string; up: string; down: string }[] };
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as { migrations: { id: string; slug: string; up: string; down: string }[] };

describe("Migration 016_discounts — up", () => {
  it("creates paykit.discounts", () => {
    expect(up).toMatch(/CREATE TABLE paykit\.discounts/i);
  });

  it("scopes uniqueness to (tenant_id, code)", () => {
    expect(up).toMatch(/UNIQUE \(tenant_id, code\)/i);
  });

  it("constrains percent to [0,100]", () => {
    expect(up).toMatch(/percent\s+NUMERIC\(5, 2\) NOT NULL CHECK \(percent >= 0 AND percent <= 100\)/i);
  });

  it("tracks redemption count and cap with non-negative guards", () => {
    expect(up).toMatch(/times_redeemed\s+INTEGER NOT NULL DEFAULT 0 CHECK \(times_redeemed >= 0\)/i);
    expect(up).toMatch(/max_redemptions\s+INTEGER CHECK \(max_redemptions IS NULL OR max_redemptions >= 0\)/i);
  });
});

describe("Migration 016_discounts — down", () => {
  it("quarantines by rename rather than dropping (no data loss)", () => {
    expect(down).toMatch(/ALTER TABLE paykit\.discounts RENAME TO discounts_quarantine_016/i);
    expect(down).not.toMatch(/DROP TABLE/i);
  });
});

describe("Manifest entry 016 (root + CLI mirror)", () => {
  for (const [label, manifest] of [
    ["root", rootManifest],
    ["cli", cliManifest],
  ] as const) {
    it(`${label} manifest registers 016 with correct filenames`, () => {
      const entry = manifest.migrations.find((m) => m.id === "016");
      expect(entry).toBeDefined();
      expect(entry!.slug).toBe("discounts");
      expect(entry!.up).toBe("016_discounts.up.sql");
      expect(entry!.down).toBe("016_discounts.down.sql");
    });

    it(`${label} manifest ids stay contiguous from 001 with no gaps`, () => {
      const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
      expect(ids.length).toBeGreaterThanOrEqual(16);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).toBe(i + 1);
      }
    });
  }
});
