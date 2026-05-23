/**
 * paykit doctor — validates env + paykit DB schema state + provider creds presence.
 *
 * Exit codes:
 *   0 = success
 *   1 = warning (recommended setup missing but paykit still functional)
 *   2 = error (paykit will not work)
 */
import type { Client } from "pg";
import type { MigrationManifest } from "./manifest-types.js";

export type CheckLevel = "ok" | "warn" | "error";

export interface CheckResult {
  readonly name: string;
  readonly level: CheckLevel;
  readonly message: string;
}

export async function runDoctor(
  client: Client,
  manifest: MigrationManifest,
): Promise<{ checks: CheckResult[]; exitCode: 0 | 1 | 2 }> {
  const checks: CheckResult[] = [];

  // 1. DB connectivity (already verified by client constructor; here we run a SELECT).
  try {
    await client.query("SELECT 1");
    checks.push({ name: "db_reachable", level: "ok", message: "Postgres connection OK" });
  } catch (err) {
    checks.push({
      name: "db_reachable",
      level: "error",
      message: `cannot SELECT 1: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { checks, exitCode: 2 };
  }

  // 2. paykit schema present.
  const schemaCheck = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
    [manifest.schema],
  );
  if (!schemaCheck.rows[0]?.exists) {
    checks.push({
      name: "paykit_schema",
      level: "warn",
      message: `schema '${manifest.schema}' does not exist — run 'paykit migrate up' first`,
    });
  } else {
    checks.push({ name: "paykit_schema", level: "ok", message: "paykit schema exists" });
  }

  // 3. All tables present (only if schema present).
  if (schemaCheck.rows[0]?.exists) {
    const tablesCheck = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [manifest.schema],
    );
    const present = new Set(tablesCheck.rows.map((r) => r.table_name));
    const expected = [
      "payment_transactions",
      "ledger_entries",
      "balance_projections",
      "webhook_events",
      "reconciliation_runs",
    ];
    const missing = expected.filter((t) => !present.has(t));
    if (missing.length > 0) {
      checks.push({
        name: "paykit_tables",
        level: "warn",
        message: `missing tables: ${missing.join(", ")} — run 'paykit migrate up'`,
      });
    } else {
      checks.push({ name: "paykit_tables", level: "ok", message: "all 5 paykit tables present" });
    }
  }

  // 4. Detect collision: paykit schema also has consumer's app tables (likely misconfiguration —
  // round-3 validation decided paykit owns SEPARATE database).
  if (schemaCheck.rows[0]?.exists) {
    const otherSchemasCheck = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
        WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast', $1)
          AND schema_name NOT LIKE 'pg_%'`,
      [manifest.schema],
    );
    const publicTablesCheck = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const publicTableCount = Number(publicTablesCheck.rows[0]?.count ?? "0");
    if (otherSchemasCheck.rows.length > 0 || publicTableCount > 0) {
      checks.push({
        name: "db_isolation",
        level: "warn",
        message: `non-paykit schemas/tables detected (${otherSchemasCheck.rows.length} schemas, ${publicTableCount} public tables). Paykit recommends a dedicated database — see docs/installation.md`,
      });
    } else {
      checks.push({ name: "db_isolation", level: "ok", message: "DB appears dedicated to paykit" });
    }
  }

  // 5. Required env vars (Stripe + SePay).
  const requiredEnvs = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SEPAY_API_KEY",
    "SEPAY_SECRET_KEY",
    "SEPAY_ACCOUNT_NUMBER",
    "SEPAY_BANK_BIN",
  ];
  const missingEnvs = requiredEnvs.filter((e) => !process.env[e]);
  if (missingEnvs.length > 0) {
    checks.push({
      name: "provider_env",
      level: "warn",
      message: `missing env vars: ${missingEnvs.join(", ")}`,
    });
  } else {
    checks.push({ name: "provider_env", level: "ok", message: "all provider env vars set" });
  }

  // Compute exit code: error trumps warn trumps ok.
  let exitCode: 0 | 1 | 2 = 0;
  for (const c of checks) {
    if (c.level === "error") exitCode = 2;
    else if (c.level === "warn" && exitCode === 0) exitCode = 1;
  }
  return { checks, exitCode };
}
