/**
 * Migration 022 shape test — the refunds aggregate + partially_refunded.
 *
 * Two things here are load-bearing rather than cosmetic, so they are asserted
 * directly against the SQL:
 *
 *   - `(provider, idempotency_key)` unique. This is what makes a retried refund
 *     request return the existing refund instead of paying out a second time.
 *   - the succeeded/ledger biconditional. A refund claiming `succeeded` without a
 *     ledger entry would inflate the derived refunded total and silently reduce
 *     the amount still refundable; a ledger entry on a non-succeeded refund would
 *     mean money moved for a refund that never completed.
 *
 * The backfill is asserted too, because its ordering is what keeps it runnable:
 * the succeeded/ledger CHECK is row-level and evaluated at INSERT, so the status
 * has to be decided before the row is written, not corrected afterwards.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "022_refunds.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "022_refunds.down.sql"), "utf8");

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 022_refunds — table", () => {
  it("creates paykit.refunds", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS paykit\.refunds/i);
  });

  it("cascades on the payment it references, leaving no orphan refunds", () => {
    expect(up).toMatch(/REFERENCES paykit\.payment_transactions\(transaction_id\)/i);
    expect(up).toMatch(/ON DELETE CASCADE/i);
  });

  it("stores the amount as integer micros, strictly positive", () => {
    expect(up).toMatch(/amount_micros\s+NUMERIC\(30,0\) NOT NULL CHECK \(amount_micros > 0\)/i);
  });

  it("constrains currency_code to an ISO-4217 alpha-3 shape", () => {
    expect(up).toMatch(
      /currency_code\s+TEXT NOT NULL CHECK \(currency_code ~ '\^\[A-Z\]\{3\}\$'\)/i,
    );
  });

  it("admits exactly the six lifecycle statuses", () => {
    const statusCheck =
      /status\s+TEXT NOT NULL DEFAULT 'requested'[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\)/i.exec(
        up,
      );
    expect(statusCheck).not.toBeNull();
    const listed = [...(statusCheck?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([
      "requested",
      "submitted",
      "pending_webhook",
      "succeeded",
      "failed",
      "rejected",
    ]);
  });

  it("ties succeeded to a ledger entry in both directions", () => {
    // Biconditional, not merely "succeeded implies an entry": a ledger entry on a
    // non-succeeded refund would mean money moved without the refund completing.
    expect(up).toMatch(/CHECK \(\(status = 'succeeded'\) = \(ledger_entry_id IS NOT NULL\)\)/i);
  });
});

describe("Migration 022_refunds — indexes", () => {
  it("makes (provider, idempotency_key) unique so a retry cannot pay out twice", () => {
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS paykit_rf_provider_idempotency_key[\s\S]*?\(provider, idempotency_key\)/i,
    );
  });

  it("maps a refund webhook to its row without colliding on absent provider ids", () => {
    const idx =
      /CREATE UNIQUE INDEX IF NOT EXISTS paykit_rf_provider_refund_id[\s\S]*?\(provider, provider_refund_id\)([\s\S]*?);/i.exec(
        up,
      );
    expect(idx).not.toBeNull();
    // Partial: rows that have no provider refund id yet are all NULL there, and a
    // non-partial unique index would let only one of them exist.
    expect(idx?.[1]).toMatch(/WHERE provider_refund_id IS NOT NULL/i);
  });

  it("indexes the refunded-total query path", () => {
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS paykit_rf_transaction_status_idx[\s\S]*?\(transaction_id, status\)/i,
    );
  });
});

describe("Migration 022_refunds — status enum extension", () => {
  it("adds partially_refunded to the payment status CHECK", () => {
    expect(up).toMatch(/'partially_refunded'/);
  });

  it("keeps every previously valid status", () => {
    for (const status of [
      "pending",
      "completed",
      "failed",
      "refunded",
      "expired",
      "quarantine",
      "refund_pending_webhook",
      "screening_pending",
    ]) {
      expect(up).toMatch(new RegExp(`'${status}'`));
    }
  });
});

describe("Migration 022_refunds — backfill", () => {
  it("decides the status before inserting, not after", () => {
    // The succeeded/ledger CHECK is row-level and evaluated at INSERT time. A
    // backfill that inserted 'succeeded' first and demoted unmatched rows in a
    // follow-up UPDATE would abort the whole migration on the first reservation
    // whose ledger entry cannot be found — the UPDATE would never run.
    const insertIdx = up.indexOf("INSERT INTO paykit.refunds");
    const cteIdx = up.indexOf("WITH reservation AS");
    expect(cteIdx).toBeGreaterThan(-1);
    expect(cteIdx).toBeLessThan(insertIdx);
  });

  it("maps every pending_refunds state onto a refund status", () => {
    for (const state of ["queued", "processing", "completed", "failed", "timed_out"]) {
      expect(up).toMatch(new RegExp(`'${state}'`));
    }
  });

  it("keeps the reconciler timeout distinguishable from a provider rejection", () => {
    expect(up).toMatch(/reconcile_timeout/);
  });

  it("records a completed reservation with no ledger entry as a finding, not as succeeded", () => {
    expect(up).toMatch(/backfill_ledger_entry_missing/);
  });

  it("negates the ledger amount back to a positive refund amount", () => {
    expect(up).toMatch(/-le\.amount_micros/);
  });

  it("does not duplicate a ledger entry that already has a refund row", () => {
    expect(up).toMatch(/NOT EXISTS[\s\S]*?r\.ledger_entry_id = le\.entry_id/i);
  });

  it("reclassifies historically over-stated refunded payments", () => {
    expect(up).toMatch(/SET status = 'partially_refunded'/i);
    expect(up).toMatch(/WHERE pt\.status = 'refunded'/i);
  });

  it("leaves a payment alone when nothing succeeded against it", () => {
    // Guard against demoting a 'refunded' payment whose refunds all predate the
    // ledger metadata this backfill reads: with a sum of 0 the correct action is
    // to leave the recorded status as-is rather than claim a partial refund.
    expect(up).toMatch(/> 0;/);
  });
});

describe("Migration 022_refunds — down", () => {
  it("drops the refunds table", () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS paykit\.refunds/i);
  });

  it("folds partially_refunded back before restoring the narrower CHECK", () => {
    const foldIdx = down.indexOf("SET status = 'refunded'");
    const checkIdx = down.indexOf("ADD CONSTRAINT payment_transactions_status_check");
    expect(foldIdx).toBeGreaterThan(-1);
    expect(foldIdx).toBeLessThan(checkIdx);
  });

  it("says plainly that rolling back loses refunds that never reached the ledger", () => {
    expect(down).toMatch(/LOSES data/i);
  });

  it("restores a CHECK without partially_refunded", () => {
    const restored = /ADD CONSTRAINT payment_transactions_status_check[\s\S]*$/i.exec(down);
    expect(restored?.[0]).not.toMatch(/'partially_refunded'/);
  });
});

describe("Manifest entry 022 (root + CLI mirror)", () => {
  for (const [label, manifest] of [
    ["root", rootManifest],
    ["cli", cliManifest],
  ] as const) {
    it(`${label} manifest registers 022 with correct filenames`, () => {
      const entry = manifest.migrations.find((m) => m.id === "022");
      expect(entry).toBeDefined();
      expect(entry?.slug).toBe("refunds");
      expect(entry?.up).toBe("022_refunds.up.sql");
      expect(entry?.down).toBe("022_refunds.down.sql");
    });

    it(`${label} manifest ids stay contiguous from 001`, () => {
      const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
      expect(ids.length).toBeGreaterThanOrEqual(22);
      ids.forEach((id, i) => expect(id).toBe(i + 1));
    });
  }
});
