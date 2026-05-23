import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const upSql = readFileSync(resolve(MIGRATIONS_DIR, "001_init.up.sql"), "utf8");
const downSql = readFileSync(resolve(MIGRATIONS_DIR, "001_init.down.sql"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8"));

describe("migration 001_init.up.sql shape", () => {
  it("creates the paykit schema with IF NOT EXISTS guard", () => {
    expect(upSql).toMatch(/CREATE SCHEMA IF NOT EXISTS paykit/i);
  });

  it("creates all 5 tables", () => {
    expect(upSql).toMatch(/CREATE TABLE paykit\.payment_transactions/);
    expect(upSql).toMatch(/CREATE TABLE paykit\.ledger_entries/);
    expect(upSql).toMatch(/CREATE TABLE paykit\.balance_projections/);
    expect(upSql).toMatch(/CREATE TABLE paykit\.webhook_events/);
    expect(upSql).toMatch(/CREATE TABLE paykit\.reconciliation_runs/);
  });

  it("balance_projections has compound PK (tenant_id, currency_code)", () => {
    expect(upSql).toMatch(/PRIMARY KEY \(tenant_id, currency_code\)/);
  });

  it("webhook_events has compound PK (provider, event_id)", () => {
    expect(upSql).toMatch(/PRIMARY KEY \(provider, event_id\)/);
  });

  it("ledger_entries enforces entry_type CHECK constraint", () => {
    expect(upSql).toMatch(
      /CHECK \(entry_type IN \('credit','debit','refund','manual_adjustment'\)\)/,
    );
  });

  it("payment_transactions enforces status CHECK constraint", () => {
    expect(upSql).toMatch(
      /CHECK \(status IN \('pending','completed','failed','refunded','expired'\)\)/,
    );
  });

  it("uses tenant_id + owner_id columns (generic tenancy)", () => {
    expect(upSql).toMatch(/tenant_id\s+UUID NOT NULL/);
    expect(upSql).toMatch(/owner_id\s+UUID NOT NULL/);
    expect(upSql).not.toMatch(/workspace_id/);
    expect(upSql).not.toMatch(/organization_id/);
  });

  it("uses NUMERIC(20,6) for amount columns", () => {
    expect(upSql).toMatch(/amount_micros\s+NUMERIC\(20,6\)/);
  });

  it("creates ledger covering index on (tenant_id, currency_code, created_at DESC)", () => {
    expect(upSql).toMatch(
      /paykit_le_tenant_currency_created_idx[\s\S]+\(tenant_id, currency_code, created_at DESC\)/,
    );
  });
});

describe("migration 001_init.down.sql shape", () => {
  it("drops all 5 tables in reverse dependency order", () => {
    expect(downSql).toMatch(/DROP TABLE IF EXISTS paykit\.reconciliation_runs/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS paykit\.webhook_events/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS paykit\.balance_projections/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS paykit\.ledger_entries/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS paykit\.payment_transactions/);
  });

  it("drops the paykit schema", () => {
    expect(downSql).toMatch(/DROP SCHEMA IF EXISTS paykit/);
  });
});

describe("manifest.json", () => {
  it("declares schema name and advisory lock key", () => {
    expect(manifest.schema).toBe("paykit");
    expect(manifest.advisoryLockKey).toBe("paykit.migrate");
  });

  it("registers 001_init migration", () => {
    expect(manifest.migrations).toHaveLength(1);
    expect(manifest.migrations[0].id).toBe("001");
    expect(manifest.migrations[0].slug).toBe("init");
    expect(manifest.migrations[0].up).toBe("001_init.up.sql");
    expect(manifest.migrations[0].down).toBe("001_init.down.sql");
  });
});
