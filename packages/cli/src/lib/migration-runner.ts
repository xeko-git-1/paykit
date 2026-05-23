/**
 * Migration runner — applies bundled SQL files to paykit's Postgres database.
 *
 * Multi-instance safe: acquires `pg_advisory_lock(hashtext('paykit.migrate'))`
 * BEFORE reading pending list. Concurrent invocation blocks then no-ops.
 *
 * Idempotent: each migration tracked in `paykit.schema_migrations`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "pg";
import type { MigrationManifest } from "./manifest-types.js";

export interface MigrationStatus {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly applied: boolean;
  readonly appliedAt: Date | null;
}

const ADVISORY_LOCK_KEY = "paykit.migrate";

async function acquireLock(client: Client): Promise<boolean> {
  const r = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
    [ADVISORY_LOCK_KEY],
  );
  return Boolean(r.rows[0]?.acquired);
}

async function releaseLock(client: Client): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
}

async function ensureMigrationsTable(client: Client, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listStatus(
  client: Client,
  manifest: MigrationManifest,
): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(client, manifest.schema);
  const r = await client.query<{ id: string; applied_at: Date }>(
    `SELECT id, applied_at FROM ${manifest.schema}.schema_migrations`,
  );
  const applied = new Map<string, Date>();
  for (const row of r.rows) applied.set(row.id, row.applied_at);

  return manifest.migrations.map((m) => ({
    id: m.id,
    slug: m.slug,
    description: m.description,
    applied: applied.has(m.id),
    appliedAt: applied.get(m.id) ?? null,
  }));
}

export async function migrateUp(
  client: Client,
  manifest: MigrationManifest,
  migrationsDir: string,
): Promise<{ applied: string[]; skipped: boolean }> {
  const acquired = await acquireLock(client);
  if (!acquired) {
    return { applied: [], skipped: true };
  }
  try {
    await ensureMigrationsTable(client, manifest.schema);
    const status = await listStatus(client, manifest);
    const pending = status.filter((s) => !s.applied);
    const appliedIds: string[] = [];

    for (const item of pending) {
      const entry = manifest.migrations.find((m) => m.id === item.id);
      if (!entry) continue;
      const sql = readFileSync(resolve(migrationsDir, entry.up), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${manifest.schema}.schema_migrations (id, slug) VALUES ($1, $2)`,
          [entry.id, entry.slug],
        );
        await client.query("COMMIT");
        appliedIds.push(entry.id);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return { applied: appliedIds, skipped: false };
  } finally {
    await releaseLock(client);
  }
}

export async function migrateDown(
  client: Client,
  manifest: MigrationManifest,
  migrationsDir: string,
  target?: string,
): Promise<{ rolledBack: string[]; skipped: boolean }> {
  const acquired = await acquireLock(client);
  if (!acquired) {
    return { rolledBack: [], skipped: true };
  }
  try {
    await ensureMigrationsTable(client, manifest.schema);
    const status = await listStatus(client, manifest);
    const applied = status.filter((s) => s.applied);
    if (applied.length === 0) {
      return { rolledBack: [], skipped: false };
    }
    // Default: rollback most recent only.
    const last = applied[applied.length - 1];
    const toRollback =
      target !== undefined
        ? applied.filter((a) => a.id === target)
        : last !== undefined
          ? [last]
          : [];
    const rolledBackIds: string[] = [];

    for (const item of toRollback.reverse()) {
      const entry = manifest.migrations.find((m) => m.id === item.id);
      if (!entry) continue;
      const sql = readFileSync(resolve(migrationsDir, entry.down), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`DELETE FROM ${manifest.schema}.schema_migrations WHERE id = $1`, [
          entry.id,
        ]);
        await client.query("COMMIT");
        rolledBackIds.push(entry.id);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return { rolledBack: rolledBackIds, skipped: false };
  } finally {
    await releaseLock(client);
  }
}
