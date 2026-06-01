/**
 * doctor table-count test (F6) — the schema check must expect the full set of
 * business tables (13) and flag any missing one (e.g. reconciliation_runs),
 * not the stale hardcoded 5. Uses a minimal mock pg.Client that returns scripted
 * query results by SQL shape.
 */
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/lib/doctor.js";
import type { MigrationManifest } from "../src/lib/manifest-types.js";

const manifest = {
  schema: "paykit",
  advisoryLockKey: "paykit.migrate",
  migrations: [],
} as unknown as MigrationManifest;

const ALL_TABLES = [
  "api_keys",
  "balance_projections",
  "customers",
  "idempotency_records",
  "ledger_entries",
  "merchants",
  "payment_transactions",
  "pending_refunds",
  "reconciliation_runs",
  "runtime_config",
  "subscription_events",
  "subscriptions",
  "webhook_events",
];

function mockClient(tables: string[]): Client {
  return {
    query: async (sql: string, _params?: unknown[]) => {
      // Schema-existence probe: SELECT EXISTS (... information_schema.schemata ...)
      if (sql.includes("information_schema.schemata") && sql.includes("EXISTS")) {
        return { rows: [{ exists: true }] };
      }
      // Table inventory for the paykit schema
      if (sql.includes("information_schema.tables") && sql.includes("table_schema = $1")) {
        return { rows: tables.map((t) => ({ table_name: t })) };
      }
      // Other-schemas isolation probe → none
      if (sql.includes("information_schema.schemata")) return { rows: [] };
      // public-table count → benign
      if (sql.includes("table_schema = 'public'")) return { rows: [{ count: "0" }] };
      // Connectivity probe (exact "SELECT 1")
      if (sql.trim() === "SELECT 1") return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    },
  } as unknown as Client;
}

describe("runDoctor — table coverage (F6)", () => {
  it("reports all 13 tables present when the schema is complete", async () => {
    const result = await runDoctor(mockClient(ALL_TABLES), manifest);
    const tablesCheck = result.checks.find((c) => c.name === "paykit_tables");
    expect(tablesCheck?.level).toBe("ok");
    expect(tablesCheck?.message).toMatch(/all 13 paykit tables present/);
  });

  it("flags reconciliation_runs as missing when absent (was hidden by the old 5-table list)", async () => {
    const without = ALL_TABLES.filter((t) => t !== "reconciliation_runs");
    const result = await runDoctor(mockClient(without), manifest);
    const tablesCheck = result.checks.find((c) => c.name === "paykit_tables");
    expect(tablesCheck?.level).toBe("warn");
    expect(tablesCheck?.message).toMatch(/reconciliation_runs/);
  });

  it("flags merchants/api_keys as missing on a partially-migrated DB", async () => {
    const without = ALL_TABLES.filter((t) => t !== "merchants" && t !== "api_keys");
    const result = await runDoctor(mockClient(without), manifest);
    const tablesCheck = result.checks.find((c) => c.name === "paykit_tables");
    expect(tablesCheck?.level).toBe("warn");
    expect(tablesCheck?.message).toMatch(/merchants/);
    expect(tablesCheck?.message).toMatch(/api_keys/);
  });
});
