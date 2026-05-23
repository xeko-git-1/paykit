import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const m002Up = readFileSync(resolve(MIGRATIONS_DIR, "002_internal_id.up.sql"), "utf8");
const m002Down = readFileSync(resolve(MIGRATIONS_DIR, "002_internal_id.down.sql"), "utf8");
const m003Up = readFileSync(resolve(MIGRATIONS_DIR, "003_pending_refunds.up.sql"), "utf8");
const m003Down = readFileSync(resolve(MIGRATIONS_DIR, "003_pending_refunds.down.sql"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8")) as {
  migrations: { id: string; slug: string }[];
};

describe("V1.5 migration 002_internal_id", () => {
  it("adds internal_id UUID column with NOT NULL DEFAULT gen_random_uuid()", () => {
    expect(m002Up).toMatch(/ADD COLUMN internal_id UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  });

  it("creates unique index on internal_id", () => {
    expect(m002Up).toMatch(/CREATE UNIQUE INDEX paykit_pt_internal_id_idx[\s\S]+\(internal_id\)/);
  });

  it("down migration drops the column + index", () => {
    expect(m002Down).toMatch(/DROP INDEX IF EXISTS paykit\.paykit_pt_internal_id_idx/);
    expect(m002Down).toMatch(/DROP COLUMN IF EXISTS internal_id/);
  });
});

describe("V1.5 migration 003_pending_refunds", () => {
  it("creates pending_refunds table with state CHECK constraint", () => {
    expect(m003Up).toMatch(/CREATE TABLE paykit\.pending_refunds/);
    expect(m003Up).toMatch(
      /CHECK \(state IN \('queued','processing','completed','failed','timed_out'\)\)/,
    );
  });

  it("references payment_transactions.transaction_id", () => {
    expect(m003Up).toMatch(/REFERENCES paykit\.payment_transactions\(transaction_id\)/);
  });

  it("enforces UNIQUE (provider, idempotency_key) for idempotent inserts", () => {
    expect(m003Up).toMatch(/UNIQUE \(provider, idempotency_key\)/);
  });

  it("indexes (state, last_polled_at) WHERE state IN queued/processing", () => {
    expect(m003Up).toMatch(
      /CREATE INDEX paykit_pr_state_polled_idx[\s\S]+state, last_polled_at[\s\S]+WHERE state IN/,
    );
  });

  it("down migration drops table + indexes", () => {
    expect(m003Down).toMatch(/DROP TABLE IF EXISTS paykit\.pending_refunds/);
  });
});

describe("V1.5 manifest", () => {
  it("registers migrations 001, 002, 003 in order", () => {
    expect(manifest.migrations).toHaveLength(3);
    expect(manifest.migrations[0]?.id).toBe("001");
    expect(manifest.migrations[1]?.id).toBe("002");
    expect(manifest.migrations[2]?.id).toBe("003");
    expect(manifest.migrations[1]?.slug).toBe("internal_id");
    expect(manifest.migrations[2]?.slug).toBe("pending_refunds");
  });
});
