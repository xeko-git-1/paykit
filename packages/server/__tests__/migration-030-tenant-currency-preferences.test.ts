/**
 * Migration 030 shape test — the per-tenant default checkout currency.
 *
 * The table exists so a generic-style checkout (`amount` with no `currency`)
 * can resolve against the tenant's stored default. The assertions pin what the
 * routers depend on: one row per tenant (PK on tenant_id — the upsert's
 * conflict target), a tenant_id that is TEXT (embedded-mode tenants have no
 * merchants row to reference), the same ISO-4217 shape check every other
 * currency column carries, and a rollback that only removes the preference —
 * never money.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const CLI_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "cli", "migrations");

const up = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "030_tenant_currency_preferences.up.sql"),
  "utf8",
);
const down = readFileSync(
  resolve(ROOT_MIGRATIONS_DIR, "030_tenant_currency_preferences.down.sql"),
  "utf8",
);

type Manifest = { migrations: { id: string; slug: string; up: string; down: string }[] };
const rootManifest = JSON.parse(
  readFileSync(resolve(ROOT_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;
const cliManifest = JSON.parse(
  readFileSync(resolve(CLI_MIGRATIONS_DIR, "manifest.json"), "utf8"),
) as Manifest;

describe("Migration 030 — up", () => {
  it("creates the table additively (IF NOT EXISTS, paykit schema)", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS paykit\.tenant_currency_preferences/i);
  });

  it("keys one row per tenant, by the ledger's TEXT tenant identity", () => {
    // TEXT rather than a merchants FK: embedded-mode tenants have no merchants
    // row, and the preference must be settable for them too.
    expect(up).toMatch(/tenant_id TEXT PRIMARY KEY/i);
    // Word-bounded with surrounding whitespace: the table NAME itself ends in
    // "…preferences", which contains the substring "references".
    expect(up).not.toMatch(/\sREFERENCES\s/);
  });

  it("carries the same ISO-4217 shape check as every other currency column", () => {
    expect(up).toMatch(/currency_code ~ '\^\[A-Z\]\{3\}\$'/);
  });

  it("says the preference is a request default, not a wallet constraint", () => {
    const prose = up
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/request default/);
  });

  it("does not touch any existing table", () => {
    expect(up).not.toMatch(/ALTER TABLE/i);
    expect(up).not.toMatch(/payment_transactions/i);
  });
});

describe("Migration 030 — down", () => {
  it("drops only the preference table", () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS paykit\.tenant_currency_preferences/i);
    expect(down).not.toMatch(/payment_transactions/i);
  });

  it("says no money data is touched", () => {
    const prose = down
      .toLowerCase()
      .replace(/\s*--\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(prose).toMatch(/no money data is touched/);
  });
});

describe("Migration 030 — registration", () => {
  it("is registered in the root manifest", () => {
    const entry = rootManifest.migrations.find((m) => m.id === "030");
    expect(entry).toBeDefined();
    expect(entry?.up).toBe("030_tenant_currency_preferences.up.sql");
    expect(entry?.down).toBe("030_tenant_currency_preferences.down.sql");
  });

  it("is mirrored identically into the cli manifest", () => {
    expect(cliManifest.migrations).toEqual(rootManifest.migrations);
  });

  it("the cli copy of the sql is byte-identical", () => {
    for (const name of [
      "030_tenant_currency_preferences.up.sql",
      "030_tenant_currency_preferences.down.sql",
    ]) {
      expect(readFileSync(resolve(CLI_MIGRATIONS_DIR, name), "utf8")).toBe(
        readFileSync(resolve(ROOT_MIGRATIONS_DIR, name), "utf8"),
      );
    }
  });
});
