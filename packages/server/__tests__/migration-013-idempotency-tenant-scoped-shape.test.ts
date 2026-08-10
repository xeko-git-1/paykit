/**
 * Migration 013 shape test — idempotency_key_tenant_scoped.
 *
 * Verifies SQL structure and manifest registration for the constraint
 * change from global unique(idempotency_key) to composite unique(tenant_id, idempotency_key).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const m013Up = readFileSync(
  resolve(MIGRATIONS_DIR, "013_idempotency_key_tenant_scoped.up.sql"),
  "utf8",
);
const m013Down = readFileSync(
  resolve(MIGRATIONS_DIR, "013_idempotency_key_tenant_scoped.down.sql"),
  "utf8",
);
const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8")) as {
  migrations: { id: string; slug: string; up: string; down: string; description: string }[];
};

describe("Migration 013_idempotency_key_tenant_scoped — up", () => {
  it("drops the old single-column unique constraint", () => {
    expect(m013Up).toMatch(/DROP CONSTRAINT IF EXISTS/i);
    expect(m013Up).toMatch(/idempotency_key/);
  });

  it("adds composite unique constraint on (tenant_id, idempotency_key)", () => {
    expect(m013Up).toMatch(/ADD CONSTRAINT/i);
    expect(m013Up).toMatch(/tenant_id.*idempotency_key/);
  });

  it("targets paykit.payment_transactions table", () => {
    expect(m013Up).toMatch(/paykit\.payment_transactions/);
  });
});

describe("Migration 013_idempotency_key_tenant_scoped — down", () => {
  it("drops the composite constraint", () => {
    expect(m013Down).toMatch(/DROP CONSTRAINT IF EXISTS/i);
    expect(m013Down).toMatch(/tenant_idem_key/);
  });

  it("re-adds single-column unique on idempotency_key", () => {
    expect(m013Down).toMatch(/ADD CONSTRAINT/i);
    expect(m013Down).toMatch(/UNIQUE\s*\(idempotency_key\)/i);
  });

  it("contains a comment warning about cross-tenant duplicate keys", () => {
    expect(m013Down).toMatch(/duplicate/i);
  });
});

describe("Manifest entry 013", () => {
  it("manifest has entry with id 013", () => {
    const entry = manifest.migrations.find((m) => m.id === "013");
    expect(entry).toBeDefined();
    expect(entry!.slug).toBe("idempotency_key_tenant_scoped");
  });

  it("manifest 013 entry points to correct filenames", () => {
    const entry = manifest.migrations.find((m) => m.id === "013");
    expect(entry).toBeDefined();
    expect(entry!.up).toBe("013_idempotency_key_tenant_scoped.up.sql");
    expect(entry!.down).toBe("013_idempotency_key_tenant_scoped.down.sql");
  });

  it("manifest ids are ascending and contiguous from 001 with no gaps", () => {
    const ids = manifest.migrations.map((m) => Number.parseInt(m.id, 10));
    expect(ids.length).toBeGreaterThanOrEqual(13);
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });

  it("013 is registered at its expected position (13th entry)", () => {
    expect(manifest.migrations[12]?.id).toBe("013");
  });
});
