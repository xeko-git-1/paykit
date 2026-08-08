/**
 * Migration 026 shape test — the webhook inbox.
 *
 * The migration exists because one row used to mean both "seen" and "done", so the
 * assertions are about the things that keep those apart: a state column with the
 * retryable states in it, dedup that is a UNIQUE constraint rather than a primary
 * key doubling as a completion marker, and a CHECK that stops a processed row from
 * existing without the payment it credited.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "026_webhook_inbox.up.sql"), "utf8");
const down = readFileSync(resolve(ROOT_MIGRATIONS_DIR, "026_webhook_inbox.down.sql"), "utf8");

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 026 — the state machine", () => {
  it("admits every state the lifecycle needs", () => {
    for (const state of [
      "received",
      "unmatched",
      "processing",
      "processed",
      "failed",
      "dead_letter",
    ]) {
      expect(up).toMatch(new RegExp(`'${state}'`));
    }
  });

  it("constrains state to that set rather than leaving it free text", () => {
    // Without the CHECK, a typo in a repo call becomes a row no query matches and
    // no worker claims — a delivery that is silently stuck, which is the failure
    // this table exists to make impossible.
    expect(up).toMatch(/state TEXT NOT NULL DEFAULT 'received'/i);
    expect(up).toMatch(/CHECK \(state IN \(/i);
  });

  it("defaults a new row to received, not processed", () => {
    expect(up).toMatch(/DEFAULT 'received'/);
  });
});

describe("Migration 026 — dedup separated from completion", () => {
  it("deduplicates on (provider, event_id) with a UNIQUE constraint", () => {
    expect(up).toMatch(/CONSTRAINT webhook_inbox_provider_event_uq UNIQUE \(provider, event_id\)/i);
  });

  it("keys the table on its own id, so the dedup key is not also the row identity", () => {
    // The old table's PK was the dedup key, which is what made "a row exists" and
    // "the work is done" the same statement.
    expect(up).toMatch(/inbox_id UUID PRIMARY KEY/i);
  });

  it("requires a processed row to name the payment it credited", () => {
    expect(up).toMatch(/CONSTRAINT webhook_inbox_processed_has_match/i);
    expect(up).toMatch(/state <> 'processed' OR matched_transaction_id IS NOT NULL/i);
  });

  it("ties processed_at to exactly the terminal states", () => {
    expect(up).toMatch(/CONSTRAINT webhook_inbox_processed_at_matches_state/i);
    expect(up).toMatch(
      /\(processed_at IS NOT NULL\) = \(state IN \('processed', 'dead_letter'\)\)/i,
    );
  });
});

describe("Migration 026 — retry and audit columns", () => {
  it("carries the retry bookkeeping a worker needs", () => {
    for (const column of [
      "processing_attempts",
      "next_retry_at",
      "lease_expires_at",
      "last_error_code",
      "last_error_message",
    ]) {
      expect(up).toMatch(new RegExp(column));
    }
  });

  it("stores the payload hash separately from the payload", () => {
    // The payload is redacted before storage, so it no longer hashes to the same
    // value — the hash has to be its own column to stay a tamper check.
    expect(up).toMatch(/payload_hash TEXT NOT NULL/i);
    expect(up).toMatch(/raw_payload TEXT/i);
  });

  it("leaves raw_payload nullable, because a retention sweep clears it", () => {
    expect(up).not.toMatch(/raw_payload TEXT[^,]*NOT NULL/i);
  });

  it("leaves tenant_id nullable, because an unmatched delivery has no tenant", () => {
    expect(up).toMatch(/tenant_id UUID,/);
    expect(up).not.toMatch(/tenant_id UUID NOT NULL/i);
  });
});

describe("Migration 026 — indexes", () => {
  it("indexes due work partially, over the claimable states only", () => {
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS paykit_webhook_inbox_due_idx/i);
    expect(up).toMatch(/WHERE state IN \('received', 'unmatched', 'failed'\)/i);
  });

  it("indexes expired leases so a dead worker's claim can be reclaimed", () => {
    expect(up).toMatch(/paykit_webhook_inbox_lease_idx/i);
    expect(up).toMatch(/WHERE state = 'processing'/i);
  });

  it("indexes dead letters for the operator view", () => {
    expect(up).toMatch(/paykit_webhook_inbox_dead_letter_idx/i);
  });
});

describe("Migration 026 — backfill", () => {
  it("carries every historical dedup row across", () => {
    expect(up).toMatch(/FROM paykit\.webhook_events/i);
    expect(up).toMatch(/ON CONFLICT \(provider, event_id\) DO NOTHING/i);
  });

  it("closes them rather than leaving them claimable", () => {
    // A historical row has no payload, so re-running it would credit nothing. It
    // must not land in a state the due-work index covers.
    expect(up).toMatch(/'dead_letter'/);
    const backfill = up.slice(up.search(/INSERT INTO paykit\.webhook_inbox/i));
    expect(backfill).not.toMatch(/'received'/);
    expect(backfill).not.toMatch(/'unmatched'/);
  });

  it("leaves webhook_events in place, so the down migration has somewhere to land", () => {
    expect(up).not.toMatch(/DROP TABLE[^;]*webhook_events/i);
  });
});

describe("Migration 026 — down", () => {
  it("drops the indexes and the table", () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS paykit\.webhook_inbox/i);
    for (const idx of [
      "paykit_webhook_inbox_due_idx",
      "paykit_webhook_inbox_lease_idx",
      "paykit_webhook_inbox_dead_letter_idx",
      "paykit_webhook_inbox_transaction_idx",
    ]) {
      expect(down).toMatch(new RegExp(`DROP INDEX IF EXISTS paykit\\.${idx}`, "i"));
    }
  });

  it("says plainly that rolling back discards incomplete work", () => {
    // Comment text wraps, so match across the line break rather than pinning a
    // phrase to one line.
    const prose = down
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/drain or export/);
    expect(prose).toMatch(/processed a second\s*time/);
  });
});

describe("Migration 026 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "026");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("026_webhook_inbox.up.sql");
    expect(entry?.down).toBe("026_webhook_inbox.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of ["026_webhook_inbox.up.sql", "026_webhook_inbox.down.sql"]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
