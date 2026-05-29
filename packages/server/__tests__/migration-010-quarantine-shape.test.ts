import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const m010Up = readFileSync(
  resolve(MIGRATIONS_DIR, "010_v3_payment_status_quarantine.up.sql"),
  "utf8",
);
const m010Down = readFileSync(
  resolve(MIGRATIONS_DIR, "010_v3_payment_status_quarantine.down.sql"),
  "utf8",
);
const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8")) as {
  migrations: { id: string; slug: string }[];
};

describe("v0.2.1 hotfix migration 010_v3_payment_status_quarantine (Val Session 1 D3)", () => {
  it("drops the existing payment_transactions_status_check constraint", () => {
    expect(m010Up).toMatch(
      /ALTER TABLE paykit\.payment_transactions[\s\S]+DROP CONSTRAINT IF EXISTS payment_transactions_status_check/,
    );
  });

  it("re-adds the CHECK with 'quarantine' in the allowed status set", () => {
    expect(m010Up).toMatch(
      /CHECK \(status IN \('pending','completed','failed','refunded','expired','quarantine'\)\)/,
    );
  });

  it("preserves all V1 status values (no destructive removal)", () => {
    for (const status of ["pending", "completed", "failed", "refunded", "expired"]) {
      expect(m010Up).toContain(`'${status}'`);
    }
  });

  it("down-migration restores V1 CHECK without 'quarantine'", () => {
    expect(m010Down).toMatch(
      /CHECK \(status IN \('pending','completed','failed','refunded','expired'\)\)/,
    );
    // Strip SQL comments before asserting absence — comments may reference
    // the value being removed.
    const downSql = m010Down.replace(/--.*$/gm, "");
    expect(downSql).not.toContain("quarantine");
  });
});

describe("V3 manifest registers 010 after 009", () => {
  it("has 010 entry with v3_payment_status_quarantine slug", () => {
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(10);
    expect(manifest.migrations[9]?.id).toBe("010");
    expect(manifest.migrations[9]?.slug).toBe("v3_payment_status_quarantine");
  });

  it("preserves V2 ordering 004-009 ahead of 010", () => {
    expect(manifest.migrations[3]?.id).toBe("004");
    expect(manifest.migrations[8]?.id).toBe("009");
    expect(manifest.migrations[8]?.slug).toBe("ledger_v2_columns");
  });
});
