/**
 * Migration 028 shape test — the inbox learns which pipeline owns a delivery.
 *
 * The column exists so subscription deliveries can share the durable inbox
 * without weakening the payment pipeline's integrity CHECK. The assertions are
 * about exactly that split: the kind is constrained to the two known pipelines,
 * the processed-must-name-a-payment guarantee stays word-for-word for payment
 * rows, and subscription rows are the only ones excused from it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "028_webhook_inbox_kind.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "028_webhook_inbox_kind.down.sql"), "utf8");

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 028 — up", () => {
  it("adds the kind column with 'payment' as the default", () => {
    // The default is what makes this additive: every pre-028 row and every write
    // from pre-028 code is a payment delivery, which is exactly what they were.
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS inbox_kind TEXT NOT NULL DEFAULT 'payment'/i);
  });

  it("constrains the kind to the two known pipelines", () => {
    expect(up).toMatch(/CONSTRAINT webhook_inbox_kind_known/i);
    expect(up).toMatch(/inbox_kind IN \('payment', 'subscription'\)/i);
  });

  it("keeps the processed-must-name-a-payment CHECK binding payment rows", () => {
    // The CHECK is re-created, not dropped: a processed payment row naming no
    // transaction is still indistinguishable from silent loss.
    expect(up).toMatch(/ADD CONSTRAINT webhook_inbox_processed_has_match/i);
    expect(up).toMatch(/matched_transaction_id IS NOT NULL/i);
  });

  it("excuses only subscription rows from the match requirement", () => {
    expect(up).toMatch(/OR inbox_kind = 'subscription'/i);
  });

  it("says why subscription rows may finish without a match", () => {
    const prose = up
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/customer\.deleted/);
    expect(prose).toMatch(/no single entity to name|nothing to name/);
  });

  it("does not touch payment_transactions", () => {
    expect(up).not.toMatch(/paykit\.payment_transactions/i);
  });
});

describe("Migration 028 — down", () => {
  it("removes subscription rows before restoring the strict CHECK", () => {
    // The restored CHECK would reject processed subscription rows with no match,
    // and pre-028 code would process any non-terminal ones as payment events.
    expect(down).toMatch(/DELETE FROM paykit\.webhook_inbox WHERE inbox_kind = 'subscription'/i);
    const deleteIdx = down.indexOf("DELETE FROM");
    const restoreIdx = down.indexOf("ADD CONSTRAINT webhook_inbox_processed_has_match");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThan(deleteIdx);
  });

  it("restores the original payment-only CHECK verbatim", () => {
    expect(down).toMatch(/CHECK \(state <> 'processed' OR matched_transaction_id IS NOT NULL\)/i);
  });

  it("drops the column last", () => {
    expect(down).toMatch(/DROP COLUMN IF EXISTS inbox_kind/i);
  });

  it("says what rolling back costs", () => {
    const prose = down
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/lose their retry state/);
  });
});

describe("Migration 028 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "028");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("028_webhook_inbox_kind.up.sql");
    expect(entry?.down).toBe("028_webhook_inbox_kind.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of ["028_webhook_inbox_kind.up.sql", "028_webhook_inbox_kind.down.sql"]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
