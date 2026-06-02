/**
 * Migration 017 shape test — discount_reserved.
 *
 * Verifies the reserved column + its non-negative CHECK, the down drop, and
 * manifest registration (root + CLI mirror).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "017_discount_reserved.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "017_discount_reserved.down.sql"), "utf8");
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as { migrations: { id: string; slug: string; up: string; down: string }[] };
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as { migrations: { id: string; slug: string; up: string; down: string }[] };

describe("Migration 017_discount_reserved — up", () => {
  it("adds a reserved column defaulting to 0 with a non-negative CHECK", () => {
    expect(up).toMatch(
      /ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK \(reserved >= 0\)/i,
    );
  });

  it("targets paykit.discounts", () => {
    expect(up).toMatch(/paykit\.discounts/);
  });

  it("does not create a new table (column-only)", () => {
    expect(up).not.toMatch(/CREATE TABLE/i);
  });
});

describe("Migration 017_discount_reserved — down", () => {
  it("drops the reserved column", () => {
    expect(down).toMatch(/DROP COLUMN IF EXISTS reserved/i);
  });
});

describe("Manifest entry 017 (root + CLI mirror)", () => {
  for (const [label, manifest] of [
    ["root", rootManifest],
    ["cli", cliManifest],
  ] as const) {
    it(`${label} manifest registers 017 with correct filenames`, () => {
      const entry = manifest.migrations.find((m) => m.id === "017");
      expect(entry).toBeDefined();
      expect(entry!.slug).toBe("discount_reserved");
      expect(entry!.up).toBe("017_discount_reserved.up.sql");
      expect(entry!.down).toBe("017_discount_reserved.down.sql");
    });

    it(`${label} manifest ids stay contiguous from 001 with no gaps`, () => {
      const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
      expect(ids.length).toBeGreaterThanOrEqual(17);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).toBe(i + 1);
      }
    });
  }
});
