/**
 * runtime-config.repo — V2. Generic key-value store with optional TTL.
 *
 * Val S4 Q3: Phase 09 boot sets `webhook_strict_v2 = false` with expires_at
 * NOW() + 24h. Phase 07 reconciler reads + flips to `true` once expired.
 *
 * `getKey` returns the raw record (caller owns TTL semantics — see Phase 07
 * reconciler's auto-flip pass). `setKey` upserts; expiresAt:null means
 * "non-expiring".
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type NewRuntimeConfig, type RuntimeConfig, runtimeConfig } from "../schema/runtime-config.js";

export async function getKey(db: DbOrTx, key: string): Promise<RuntimeConfig | undefined> {
  const [row] = await db
    .select()
    .from(runtimeConfig)
    .where(eq(runtimeConfig.key, key))
    .limit(1);
  return row;
}

export interface SetKeyInput {
  readonly key: string;
  readonly value: string;
  readonly expiresAt?: Date | null;
}

export async function setKey(db: DbOrTx, input: SetKeyInput): Promise<RuntimeConfig> {
  const now = new Date();
  const expiresAt = input.expiresAt ?? null;
  const insert: NewRuntimeConfig = {
    key: input.key,
    value: input.value,
    expiresAt,
    updatedAt: now,
  };
  const [row] = await db
    .insert(runtimeConfig)
    .values(insert)
    .onConflictDoUpdate({
      target: runtimeConfig.key,
      set: { value: input.value, expiresAt, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("setKey: upsert returned no row");
  return row;
}

export async function ensureKey(db: DbOrTx, input: SetKeyInput): Promise<RuntimeConfig> {
  const existing = await getKey(db, input.key);
  if (existing) return existing;
  return setKey(db, input);
}

/**
 * Atomic claim: INSERT ... ON CONFLICT DO NOTHING. If the row already exists
 * (another instance won the race), re-SELECT to return the winner's value.
 * This guarantees all concurrent callers converge on the same stored value
 * without clobbering — critical for JWT secret seeding across replicas.
 */
export async function claimKey(db: DbOrTx, input: SetKeyInput): Promise<RuntimeConfig> {
  const now = new Date();
  const expiresAt = input.expiresAt ?? null;
  const insert: NewRuntimeConfig = {
    key: input.key,
    value: input.value,
    expiresAt,
    updatedAt: now,
  };
  const [inserted] = await db
    .insert(runtimeConfig)
    .values(insert)
    .onConflictDoNothing({ target: runtimeConfig.key })
    .returning();

  if (inserted) return inserted;

  // Another instance won the race — read the winner's value
  const winner = await getKey(db, input.key);
  if (!winner) {
    throw new Error("claimKey: row vanished after conflict (concurrent DELETE?)");
  }
  return winner;
}
