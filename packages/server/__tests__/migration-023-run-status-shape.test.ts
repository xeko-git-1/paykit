/**
 * Migration 023 shape test — the reconciliation run status vocabulary.
 *
 * The point of the migration is that four outcomes exist where the column allowed
 * two, so the assertions are about the vocabulary itself: `partial` and `skipped`
 * must be admissible, and the down migration must fold them before restoring the
 * narrower CHECK (leaving them would make the restore fail on live data).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "023_reconciliation_run_status.up.sql"),
  "utf8",
);
const down = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "023_reconciliation_run_status.down.sql"),
  "utf8",
);

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 023 — up", () => {
  it("replaces the status CHECK rather than adding a second one", () => {
    // Two CHECKs on the same column would AND together, admitting only the
    // intersection — which is the old three-value set.
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS reconciliation_runs_status_check/i);
    expect(up).toMatch(/ADD CONSTRAINT reconciliation_runs_status_check/i);
  });

  it("admits partial — some providers reconciled, at least one did not", () => {
    expect(up).toMatch(/'partial'/);
  });

  it("admits skipped — the lock was held, so nothing ran and nothing failed", () => {
    expect(up).toMatch(/'skipped'/);
  });

  it("keeps the three statuses that already existed", () => {
    for (const status of ["running", "completed", "failed"]) {
      expect(up).toMatch(new RegExp(`'${status}'`));
    }
  });

  it("does not add columns no code reads yet", () => {
    // A column nothing writes is schema drift: the next reader cannot tell whether
    // it is unused or whether its writer is broken.
    expect(up).not.toMatch(/ADD COLUMN/i);
  });
});

describe("Migration 023 — down", () => {
  it("folds the new statuses before restoring the narrower CHECK", () => {
    // Order matters: restoring the CHECK first fails on any row already holding
    // 'partial' or 'skipped'.
    const foldAt = down.search(/UPDATE paykit\.reconciliation_runs/i);
    const checkAt = down.search(/ADD CONSTRAINT reconciliation_runs_status_check/i);
    expect(foldAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(foldAt).toBeLessThan(checkAt);
  });

  it("restores exactly the original three-status set", () => {
    expect(down).toMatch(/CHECK \(status IN \('running', 'completed', 'failed'\)\)/i);
    expect(down).not.toMatch(/'partial'[^)]*\)\s*\)\s*;?\s*$/);
  });

  it("says plainly that rolling back re-conflates the outcomes", () => {
    expect(down.toLowerCase()).toMatch(/indistinguishable|conflat/);
  });
});

describe("Migration 023 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "023");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("023_reconciliation_run_status.up.sql");
    expect(entry?.down).toBe("023_reconciliation_run_status.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    // The CLI ships its own copy; a drift between them means `paykit migrate`
    // applies a different set than the repo describes.
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of [
      "023_reconciliation_run_status.up.sql",
      "023_reconciliation_run_status.down.sql",
    ]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
