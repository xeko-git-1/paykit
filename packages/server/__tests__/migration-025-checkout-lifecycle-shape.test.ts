/**
 * Migration 025 shape test — the checkout lifecycle states and the stored answer.
 *
 * The migration exists so a checkout that spans this database and the provider can
 * be recovered, so the assertions are about exactly that: the pre-provider state
 * must be nameable (`provider_creating`), the provider's answer must have somewhere
 * to live that other writers do not rewrite, and `pending` must survive because
 * every historical row uses it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "025_checkout_lifecycle.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "025_checkout_lifecycle.down.sql"), "utf8");

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 025 — up", () => {
  it("replaces the status CHECK rather than adding a second one", () => {
    // Two CHECKs on one column AND together, admitting only the intersection —
    // which is the old vocabulary, so the new states would be rejected.
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS payment_transactions_status_check/i);
    expect(up).toMatch(/ADD CONSTRAINT payment_transactions_status_check/i);
  });

  it("admits provider_creating — the row exists, the provider has not answered", () => {
    expect(up).toMatch(/'provider_creating'/);
  });

  it("admits awaiting_payment — the provider has a session, nobody has paid", () => {
    expect(up).toMatch(/'awaiting_payment'/);
  });

  it("keeps pending, because every historical row holds it", () => {
    // Dropping it would invalidate existing data rather than migrate it.
    expect(up).toMatch(/'pending'/);
  });

  it("keeps every status that already existed", () => {
    for (const status of [
      "completed",
      "failed",
      "refunded",
      "partially_refunded",
      "expired",
      "quarantine",
      "refund_pending_webhook",
      "screening_pending",
    ]) {
      expect(up).toMatch(new RegExp(`'${status}'`));
    }
  });

  it("adds checkout_result_json for the provider answer a replay must return", () => {
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS checkout_result_json JSONB/i);
  });

  it("leaves checkout_result_json nullable, since existing rows have no answer", () => {
    // A NOT NULL here would fail on every historical row.
    expect(up).not.toMatch(/checkout_result_json JSONB[^;]*NOT NULL/i);
  });

  it("indexes rows stuck mid-creation, and only those rows", () => {
    // The reconcile query runs on a schedule against a table where in-flight rows
    // are a vanishing fraction; a full index would be mostly dead weight.
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS paykit_pt_provider_creating_idx/i);
    expect(up).toMatch(/WHERE status = 'provider_creating'/i);
  });
});

describe("Migration 025 — down", () => {
  it("folds the new statuses before restoring the narrower CHECK", () => {
    // Order matters: restoring the CHECK first fails on any row still holding
    // 'provider_creating' or 'awaiting_payment'.
    const foldAt = down.search(/UPDATE paykit\.payment_transactions/i);
    const checkAt = down.search(/ADD CONSTRAINT payment_transactions_status_check/i);
    expect(foldAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(foldAt).toBeLessThan(checkAt);
  });

  it("folds both new states into pending", () => {
    expect(down).toMatch(/status IN \('provider_creating', 'awaiting_payment'\)/i);
    expect(down).toMatch(/SET status = 'pending'/i);
  });

  it("drops the column and its index", () => {
    expect(down).toMatch(/DROP INDEX IF EXISTS paykit\.paykit_pt_provider_creating_idx/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS checkout_result_json/i);
  });

  it("restores a CHECK without the two new states", () => {
    const restored = down.slice(down.search(/ADD CONSTRAINT payment_transactions_status_check/i));
    expect(restored).not.toMatch(/'provider_creating'/);
    expect(restored).not.toMatch(/'awaiting_payment'/);
    expect(restored).toMatch(/'pending'/);
  });

  it("says plainly what rolling back costs", () => {
    // A rollback loses the one signal that a session may exist upstream, and every
    // stored provider answer. That has to be readable by whoever runs it.
    expect(down.toLowerCase()).toMatch(/reconcile any/);
    expect(down.toLowerCase()).toMatch(/loses every stored provider answer/);
  });
});

describe("Migration 025 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "025");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("025_checkout_lifecycle.up.sql");
    expect(entry?.down).toBe("025_checkout_lifecycle.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    // The CLI ships its own copy; drift means `paykit migrate` applies a different
    // set than the repo describes.
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of ["025_checkout_lifecycle.up.sql", "025_checkout_lifecycle.down.sql"]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
