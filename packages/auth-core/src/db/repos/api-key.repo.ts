/**
 * api-key.repo — persistence helpers for the api_keys table.
 *
 * All functions accept a DbOrTx so they compose inside transactions.
 * touchLastUsed is designed to be called fire-and-forget; its failure
 * must never block an auth decision.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type ApiKey, type NewApiKey, apiKeys } from "../schema/api-keys.js";

// ---------------------------------------------------------------------------
// findByHash — primary lookup for verify flow
// ---------------------------------------------------------------------------
export async function findByHash(db: DbOrTx, keyHash: string): Promise<ApiKey | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// insert — persist a newly minted key record
// ---------------------------------------------------------------------------
export async function insert(db: DbOrTx, record: NewApiKey): Promise<ApiKey> {
  const [row] = await db.insert(apiKeys).values(record).returning();
  if (!row) throw new Error("api-key.repo.insert: returning() yielded no row");
  return row;
}

// ---------------------------------------------------------------------------
// markRevoked — soft-revoke by setting revoked_at
// ---------------------------------------------------------------------------
export async function markRevoked(db: DbOrTx, keyId: string): Promise<void> {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.keyId, keyId));
}

// ---------------------------------------------------------------------------
// touchLastUsed — async audit trail; failure is non-fatal
// ---------------------------------------------------------------------------
export async function touchLastUsed(db: DbOrTx, keyId: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.keyId, keyId));
}

// ---------------------------------------------------------------------------
// countActiveByMerchant — durable per-merchant key cap enforcement
// ---------------------------------------------------------------------------

/**
 * Counts non-revoked keys for a merchant. Used to enforce per-merchant
 * active-key cap at mint time (durable, multi-instance-safe — DB is the
 * single source of truth, not in-memory counters).
 */
export async function countActiveByMerchant(db: DbOrTx, merchantId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.merchantId, merchantId), isNull(apiKeys.revokedAt)));
  return result?.count ?? 0;
}
