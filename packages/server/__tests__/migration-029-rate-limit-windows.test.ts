/**
 * Migration 029 shape test — the durable rate-limit counter.
 *
 * The table exists so the /v1 rate limit holds across every instance and every
 * restart. The assertions pin the properties the middleware depends on: one
 * row per credential (PK on bucket_key — the upsert's conflict target), the
 * window and count both present, and a rollback that leaves the middleware on
 * its documented in-memory fallback rather than broken.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "029_rate_limit_windows.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "029_rate_limit_windows.down.sql"), "utf8");

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 029 — up", () => {
  it("creates the table additively (IF NOT EXISTS, paykit schema)", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS paykit\.rate_limit_windows/i);
  });

  it("keys one row per credential — the upsert's conflict target", () => {
    // The whole consume is one INSERT .. ON CONFLICT (bucket_key); without the
    // PK the upsert has nothing to conflict on and every request inserts.
    expect(up).toMatch(/bucket_key TEXT PRIMARY KEY/i);
  });

  it("stores the window start and the request count", () => {
    expect(up).toMatch(/window_start TIMESTAMPTZ NOT NULL/i);
    expect(up).toMatch(/request_count INTEGER NOT NULL DEFAULT 0/i);
  });

  it("says why the count includes rejected requests", () => {
    const prose = up
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/including rejected ones|rejected ones/);
  });

  it("does not touch any existing table", () => {
    expect(up).not.toMatch(/ALTER TABLE/i);
    expect(up).not.toMatch(/payment_transactions/i);
  });
});

describe("Migration 029 — down", () => {
  it("drops only the counter table", () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS paykit\.rate_limit_windows/i);
    expect(down).not.toMatch(/payment_transactions/i);
  });

  it("names the fallback the middleware degrades to", () => {
    const prose = down
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/per-process bucket|in-memory/);
  });
});

describe("Migration 029 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "029");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("029_rate_limit_windows.up.sql");
    expect(entry?.down).toBe("029_rate_limit_windows.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of ["029_rate_limit_windows.up.sql", "029_rate_limit_windows.down.sql"]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
