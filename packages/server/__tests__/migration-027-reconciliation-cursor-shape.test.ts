/**
 * Migration 027 shape test — the reconciliation cursor.
 *
 * The cursor exists so a window bigger than one invocation can still be finished, so
 * the assertions are about the things that make a stored position usable: a keyset
 * of both ordering columns, the window it belongs to, a finished flag, and the index
 * the paging query needs to not re-sort the window on every batch.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "027_reconciliation_cursor.up.sql"), "utf8");
const down = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "027_reconciliation_cursor.down.sql"),
  "utf8",
);

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 027 — up", () => {
  it("keys the cursor on provider, so a position outlives one run", () => {
    expect(up).toMatch(/provider TEXT PRIMARY KEY/i);
  });

  it("stores a keyset of BOTH ordering columns", () => {
    // created_at alone is not unique: a page boundary inside a group of rows sharing
    // one timestamp would repeat or drop the rest of that group.
    expect(up).toMatch(/last_created_at TIMESTAMPTZ/i);
    expect(up).toMatch(/last_transaction_id UUID/i);
  });

  it("requires the position to be complete or absent, never half", () => {
    // Half a position cannot be used as a keyset and would silently degrade to
    // "start from the beginning" on a path that believes it is resuming.
    expect(up).toMatch(/CONSTRAINT reconciliation_cursors_position_complete/i);
    expect(up).toMatch(/\(last_created_at IS NULL\) = \(last_transaction_id IS NULL\)/i);
  });

  it("records the window the position belongs to", () => {
    // A position means nothing without its window: resuming into a window it never
    // walked would skip everything before it.
    expect(up).toMatch(/window_since TIMESTAMPTZ/i);
    expect(up).toMatch(/window_until TIMESTAMPTZ/i);
  });

  it("carries a finished flag", () => {
    expect(up).toMatch(/exhausted BOOLEAN NOT NULL DEFAULT FALSE/i);
  });

  it("indexes provider first, then the columns the keyset scan orders on", () => {
    // Column order is the whole value of this index. With (created_at,
    // transaction_id) alone, Postgres filters by provider through a different index
    // and then sorts — verified on a real instance, where dropping `provider` turned
    // an Index Only Scan back into an Index Scan plus Sort. That sort, once per
    // page, is worse than the single unbounded select the paging replaced.
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS paykit_pt_reconcile_keyset_idx/i);
    expect(up).toMatch(/\(provider, created_at, transaction_id\)/i);
  });

  it("says why a keyset rather than an offset", () => {
    // The reason is the whole point and is easy to "simplify" away later. Comment
    // text wraps, so match across line breaks rather than pinning it to one line.
    const prose = up
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/offset/);
    expect(prose).toMatch(/skipping a payment/);
  });

  it("does not touch payment_transactions data", () => {
    expect(up).not.toMatch(/UPDATE paykit\.payment_transactions/i);
    expect(up).not.toMatch(/ALTER TABLE paykit\.payment_transactions/i);
  });
});

describe("Migration 027 — down", () => {
  it("drops the table and the index it added", () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS paykit\.reconciliation_cursors/i);
    expect(down).toMatch(/DROP INDEX IF EXISTS paykit\.paykit_pt_reconcile_keyset_idx/i);
  });

  it("says what rolling back costs", () => {
    const prose = down
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/restarts its window/);
  });
});

describe("Migration 027 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "027");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("027_reconciliation_cursor.up.sql");
    expect(entry?.down).toBe("027_reconciliation_cursor.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of ["027_reconciliation_cursor.up.sql", "027_reconciliation_cursor.down.sql"]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
