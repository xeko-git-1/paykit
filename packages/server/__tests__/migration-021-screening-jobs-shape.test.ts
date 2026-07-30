/**
 * Migration 021 shape test — screening_jobs + the screening_pending status.
 *
 * The columns asserted here are the ones the deferred-credit path cannot work
 * without: the frozen credit amount and currency (re-deriving them at verdict
 * time could reach a different answer), the ledger source_id (so the deferred
 * credit collapses with a provider resend), and owner_id (the ledger write needs
 * it and the payment row is no longer in scope by then).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "021_screening_jobs.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "021_screening_jobs.down.sql"), "utf8");

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 021_screening_jobs — up", () => {
  it("creates paykit.screening_jobs", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS paykit\.screening_jobs/i);
  });

  it("makes transaction_id unique so enqueue is idempotent per payment", () => {
    expect(up).toMatch(/UNIQUE \(transaction_id\)/i);
  });

  it("cascades on the payment it references, leaving no orphan jobs", () => {
    expect(up).toMatch(/REFERENCES paykit\.payment_transactions\(transaction_id\)/i);
    expect(up).toMatch(/ON DELETE CASCADE/i);
  });

  it("carries the frozen credit amount as positive integer micros", () => {
    expect(up).toMatch(/credit_micros\s+NUMERIC\(30,0\) NOT NULL CHECK \(credit_micros > 0\)/i);
  });

  it("constrains currency_code to the ISO-4217 alpha-3 shape", () => {
    expect(up).toMatch(
      /currency_code\s+TEXT NOT NULL CHECK \(currency_code ~ '\^\[A-Z\]\{3\}\$'\)/i,
    );
  });

  it("carries owner_id and source_id, which the deferred ledger write needs", () => {
    expect(up).toMatch(/owner_id\s+UUID NOT NULL/i);
    expect(up).toMatch(/source_id\s+TEXT NOT NULL/i);
  });

  it("restricts state to the five job states", () => {
    expect(up).toMatch(/'pending'/);
    expect(up).toMatch(/'in_progress'/);
    expect(up).toMatch(/'cleared'/);
    expect(up).toMatch(/'rejected'/);
    expect(up).toMatch(/'manual_review'/);
  });

  it("has the lease and backoff columns a crashed worker is recovered by", () => {
    expect(up).toMatch(/lease_expires_at TIMESTAMPTZ/i);
    expect(up).toMatch(/next_attempt_at\s+TIMESTAMPTZ NOT NULL/i);
    expect(up).toMatch(/attempts\s+INTEGER NOT NULL DEFAULT 0 CHECK \(attempts >= 0\)/i);
  });

  it("adds screening_pending to the payment status set without dropping any prior state", () => {
    expect(up).toMatch(/'screening_pending'/);
    for (const status of [
      "pending",
      "completed",
      "failed",
      "refunded",
      "expired",
      "quarantine",
      "refund_pending_webhook",
    ]) {
      expect(up).toMatch(new RegExp(`'${status}'`));
    }
  });

  it("does not contain money CHECK constraints — those belong to 020", () => {
    expect(up).not.toMatch(/payment_transactions_amount_micros_positive/);
    expect(up).not.toMatch(/ledger_entries_amount_micros_nonzero/);
  });
});

describe("Migration 021_screening_jobs — down", () => {
  it("drops the jobs table", () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS paykit\.screening_jobs/i);
  });

  it("reverts the status set to one without screening_pending", () => {
    const statusRevert = down.slice(down.indexOf("payment_transactions_status_check"));
    expect(statusRevert).not.toMatch(/'screening_pending'/);
    expect(statusRevert).toMatch(/'refund_pending_webhook'/);
  });
});

describe("Manifest entry 021 (root + CLI mirror)", () => {
  for (const [label, manifest] of [
    ["root", rootManifest],
    ["cli", cliManifest],
  ] as const) {
    it(`${label} manifest registers 021 with correct filenames`, () => {
      const entry = manifest.migrations.find((m) => m.id === "021");
      expect(entry).toBeDefined();
      expect(entry?.slug).toBe("screening_jobs");
      expect(entry?.up).toBe("021_screening_jobs.up.sql");
      expect(entry?.down).toBe("021_screening_jobs.down.sql");
    });

    it(`${label} manifest ids stay contiguous from 001 with no gaps`, () => {
      const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
      expect(ids.length).toBeGreaterThanOrEqual(21);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).toBe(i + 1);
      }
    });
  }

  it("020 no longer declares the screening handoff it used to carry", () => {
    const money = readFileSync(
      resolve(ROOT_MIGRATIONS_DIR, "020_money_and_currency_invariants.up.sql"),
      "utf8",
    );
    expect(money).not.toMatch(/screening_jobs/);
    expect(money).not.toMatch(/screening_pending/);
  });
});
