/**
 * Migration 015 shape test — idempotency_in_flight_state.
 *
 * Verifies the SQL adds a CHECK-constrained state column, makes response_status
 * nullable, and that the down migration cleans up in_flight rows before
 * restoring NOT NULL. Also checks manifest registration in both root and CLI.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "015_idempotency_in_flight_state.up.sql"),
  "utf8",
);
const down = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "015_idempotency_in_flight_state.down.sql"),
  "utf8",
);
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as { migrations: { id: string; slug: string; up: string; down: string }[] };
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as { migrations: { id: string; slug: string; up: string; down: string }[] };

describe("Migration 015_idempotency_in_flight_state — up", () => {
  it("adds a state column constrained to in_flight|done", () => {
    expect(up).toMatch(/ADD COLUMN state TEXT NOT NULL DEFAULT 'done'/i);
    expect(up).toMatch(/CHECK\s*\(state IN \('in_flight', 'done'\)\)/i);
  });

  it("makes response_status nullable (in_flight rows have no response yet)", () => {
    expect(up).toMatch(/ALTER COLUMN response_status DROP NOT NULL/i);
  });

  it("targets paykit.idempotency_records", () => {
    expect(up).toMatch(/paykit\.idempotency_records/);
  });

  it("does not create a new table (column-only migration)", () => {
    expect(up).not.toMatch(/CREATE TABLE/i);
  });
});

describe("Migration 015_idempotency_in_flight_state — down", () => {
  it("deletes in_flight rows before restoring NOT NULL (they hold NULL status)", () => {
    expect(down).toMatch(/DELETE FROM paykit\.idempotency_records WHERE state = 'in_flight'/i);
    expect(down).toMatch(/ALTER COLUMN response_status SET NOT NULL/i);
  });

  it("drops the state column", () => {
    expect(down).toMatch(/DROP COLUMN IF EXISTS state/i);
  });
});

describe("Manifest entry 015 (root + CLI mirror)", () => {
  for (const [label, manifest] of [
    ["root", rootManifest],
    ["cli", cliManifest],
  ] as const) {
    it(`${label} manifest registers 015 with correct filenames`, () => {
      const entry = manifest.migrations.find((m) => m.id === "015");
      expect(entry).toBeDefined();
      expect(entry!.slug).toBe("idempotency_in_flight_state");
      expect(entry!.up).toBe("015_idempotency_in_flight_state.up.sql");
      expect(entry!.down).toBe("015_idempotency_in_flight_state.down.sql");
    });

    it(`${label} manifest ids stay contiguous from 001 with no gaps`, () => {
      const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
      expect(ids.length).toBeGreaterThanOrEqual(15);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).toBe(i + 1);
      }
    });
  }
});
