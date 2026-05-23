#!/usr/bin/env node
/**
 * paykit — CLI for the paykit npm package.
 *
 * Commands:
 *   paykit migrate up [--db-url <url>]
 *   paykit migrate down [--target <id>] [--db-url <url>]
 *   paykit migrate status [--db-url <url>]
 *   paykit doctor [--db-url <url>]
 *   paykit --version
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cac from "cac";
import { Client } from "pg";
import { runDoctor } from "../lib/doctor.js";
import { loadEnv } from "../lib/env-loader.js";
import type { MigrationManifest } from "../lib/manifest-types.js";
import { listStatus, migrateDown, migrateUp } from "../lib/migration-runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "..", "..", "migrations");
const MANIFEST_PATH = resolve(MIGRATIONS_DIR, "manifest.json");
const PKG_JSON_PATH = resolve(HERE, "..", "..", "package.json");

function loadManifest(): MigrationManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as MigrationManifest;
}

function loadVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8")) as { version: string };
  return pkg.version;
}

async function withClient<T>(
  dbUrl: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const env = loadEnv(dbUrl);
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const cli = cac("paykit");

cli
  .command("migrate up", "Apply all pending migrations")
  .option("--db-url <url>", "Postgres URL")
  .action(async (opts: { dbUrl?: string }) => {
    const manifest = loadManifest();
    const result = await withClient(opts.dbUrl, (c) => migrateUp(c, manifest, MIGRATIONS_DIR));
    if (result.skipped) {
      console.log("paykit migrate up: another instance holds the lock — skipped (no-op).");
      return;
    }
    if (result.applied.length === 0) {
      console.log("paykit migrate up: nothing to apply (already at HEAD).");
      return;
    }
    console.log(`paykit migrate up: applied ${result.applied.length} migration(s):`);
    for (const id of result.applied) console.log(`  ✓ ${id}`);
  });

cli
  .command("migrate down", "Roll back the most recent migration (or --target <id>)")
  .option("--target <id>", "Specific migration id to roll back")
  .option("--db-url <url>", "Postgres URL")
  .action(async (opts: { target?: string; dbUrl?: string }) => {
    const manifest = loadManifest();
    const result = await withClient(opts.dbUrl, (c) =>
      migrateDown(c, manifest, MIGRATIONS_DIR, opts.target),
    );
    if (result.skipped) {
      console.log("paykit migrate down: another instance holds the lock — skipped (no-op).");
      return;
    }
    if (result.rolledBack.length === 0) {
      console.log("paykit migrate down: nothing applied to roll back.");
      return;
    }
    console.log(`paykit migrate down: rolled back ${result.rolledBack.length} migration(s):`);
    for (const id of result.rolledBack) console.log(`  ↩ ${id}`);
  });

cli
  .command("migrate status", "Show applied + pending migrations")
  .option("--db-url <url>", "Postgres URL")
  .action(async (opts: { dbUrl?: string }) => {
    const manifest = loadManifest();
    const status = await withClient(opts.dbUrl, (c) => listStatus(c, manifest));
    for (const s of status) {
      const mark = s.applied ? "✓" : "⏸";
      const date = s.appliedAt ? s.appliedAt.toISOString() : "pending";
      console.log(`  ${mark} ${s.id}  ${s.slug.padEnd(20)}  ${date}`);
    }
  });

cli
  .command("doctor", "Check env + DB schema state + provider creds")
  .option("--db-url <url>", "Postgres URL")
  .action(async (opts: { dbUrl?: string }) => {
    const manifest = loadManifest();
    const result = await withClient(opts.dbUrl, (c) => runDoctor(c, manifest));
    for (const c of result.checks) {
      const mark = c.level === "ok" ? "✓" : c.level === "warn" ? "⚠" : "✗";
      console.log(`  ${mark} ${c.name.padEnd(20)}  ${c.message}`);
    }
    process.exit(result.exitCode);
  });

cli.help();
cli.version(loadVersion());
cli.parse();
