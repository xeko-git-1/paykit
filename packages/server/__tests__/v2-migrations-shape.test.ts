import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");
const m004Up = readFileSync(resolve(MIGRATIONS_DIR, "004_customers.up.sql"), "utf8");
const m004Down = readFileSync(resolve(MIGRATIONS_DIR, "004_customers.down.sql"), "utf8");
const m005Up = readFileSync(resolve(MIGRATIONS_DIR, "005_subscriptions.up.sql"), "utf8");
const m006Up = readFileSync(resolve(MIGRATIONS_DIR, "006_subscription_events.up.sql"), "utf8");
const m007Up = readFileSync(resolve(MIGRATIONS_DIR, "007_idempotency_records.up.sql"), "utf8");
const m008Up = readFileSync(resolve(MIGRATIONS_DIR, "008_runtime_config.up.sql"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8")) as {
  migrations: { id: string; slug: string }[];
};

describe("V2 migration 004_customers", () => {
  it("creates paykit.customers with compound PK (tenant_id, provider)", () => {
    expect(m004Up).toMatch(/CREATE TABLE paykit\.customers/);
    expect(m004Up).toMatch(/PRIMARY KEY \(tenant_id, provider\)/);
  });

  it("bounds provider_customer_id length 1..255 (RT 15i)", () => {
    expect(m004Up).toMatch(
      /provider_customer_id\s+TEXT NOT NULL CHECK \(length\(provider_customer_id\) BETWEEN 1 AND 255\)/,
    );
  });

  it("metadata_json has 4KB pg_column_size cap (RT 15i)", () => {
    expect(m004Up).toMatch(/CHECK \(pg_column_size\(metadata_json\) <= 4096\)/);
  });

  it("down drops the table", () => {
    expect(m004Down).toMatch(/DROP TABLE IF EXISTS paykit\.customers/);
  });
});

describe("V2 migration 005_subscriptions (RT F3, F9, F10)", () => {
  it("status is TEXT NOT NULL with NO CHECK enum (RT F3 — adapter validates app-side)", () => {
    expect(m005Up).toMatch(/status\s+TEXT NOT NULL/);
    expect(m005Up).not.toMatch(/CHECK \(status IN \(/);
  });

  it("requires last_event_created TIMESTAMPTZ NOT NULL (RT F9)", () => {
    expect(m005Up).toMatch(/last_event_created\s+TIMESTAMPTZ NOT NULL/);
  });

  it("declares UNIQUE (provider, provider_subscription_id) for upsert conflict target (RT F10)", () => {
    expect(m005Up).toMatch(/UNIQUE \(provider, provider_subscription_id\)/);
  });

  it("indexes (tenant_id, status) for tenant subscription queries", () => {
    expect(m005Up).toMatch(
      /paykit_subs_tenant_status_idx[\s\S]+ON paykit\.subscriptions \(tenant_id, status\)/,
    );
  });
});

describe("V2 migration 006_subscription_events append-only (RT 15j)", () => {
  it("creates BEFORE UPDATE OR DELETE trigger raising exception", () => {
    expect(m006Up).toMatch(/BEFORE UPDATE OR DELETE ON paykit\.subscription_events/);
    expect(m006Up).toMatch(/RAISE EXCEPTION 'paykit\.subscription_events is append-only/);
  });

  it("REVOKEs UPDATE, DELETE on paykit_app role", () => {
    expect(m006Up).toMatch(/REVOKE UPDATE, DELETE ON paykit\.subscription_events FROM paykit_app/);
  });

  it("indexes (subscription_id, created_at DESC) for audit lookups", () => {
    expect(m006Up).toMatch(
      /paykit_sub_events_sub_created_idx[\s\S]+\(subscription_id, created_at DESC\)/,
    );
  });
});

describe("V2 migration 007_idempotency_records (RT F6)", () => {
  it("compound PK (tenant_id, idempotency_key) blocks cross-tenant collision", () => {
    expect(m007Up).toMatch(/PRIMARY KEY \(tenant_id, idempotency_key\)/);
  });

  it("expires_at default = NOW() + INTERVAL '24 hours'", () => {
    expect(m007Up).toMatch(/expires_at[\s\S]+DEFAULT \(NOW\(\) \+ INTERVAL '24 hours'\)/);
  });

  it("indexes expires_at for TTL sweeper", () => {
    expect(m007Up).toMatch(/paykit_idemp_expires_idx[\s\S]+\(expires_at\)/);
  });

  it("captures request_body_hash + response_status + response_body_json", () => {
    expect(m007Up).toMatch(/request_body_hash\s+TEXT NOT NULL/);
    expect(m007Up).toMatch(/response_status\s+INTEGER NOT NULL/);
    expect(m007Up).toMatch(/response_body_json\s+JSONB/);
  });
});

describe("V2 migration 008_runtime_config (Val S4 Q3)", () => {
  it("PK is just key", () => {
    expect(m008Up).toMatch(/key\s+TEXT PRIMARY KEY/);
  });

  it("expires_at is nullable (non-expiring keys allowed)", () => {
    expect(m008Up).toMatch(/expires_at\s+TIMESTAMPTZ(?!\s*NOT NULL)/);
  });

  it("value is NOT NULL TEXT", () => {
    expect(m008Up).toMatch(/value\s+TEXT NOT NULL/);
  });
});

describe("V2 manifest registers 004-008 in order", () => {
  it("has migrations 001..008+ sequential", () => {
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(8);
    expect(manifest.migrations[3]?.id).toBe("004");
    expect(manifest.migrations[3]?.slug).toBe("customers");
    expect(manifest.migrations[4]?.id).toBe("005");
    expect(manifest.migrations[4]?.slug).toBe("subscriptions");
    expect(manifest.migrations[5]?.id).toBe("006");
    expect(manifest.migrations[5]?.slug).toBe("subscription_events");
    expect(manifest.migrations[6]?.id).toBe("007");
    expect(manifest.migrations[6]?.slug).toBe("idempotency_records");
    expect(manifest.migrations[7]?.id).toBe("008");
    expect(manifest.migrations[7]?.slug).toBe("runtime_config");
  });
});
