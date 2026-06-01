/**
 * merchant.repo — persistence helpers for the merchants table.
 *
 * merchants is the root tenant entity in V4 service mode: merchant_id is the
 * tenantId/ownerId for the ledger and payment context. All functions accept a
 * DbOrTx so they compose inside transactions.
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type Merchant, type NewMerchant, merchants } from "../schema/merchants.js";

// ---------------------------------------------------------------------------
// insert — create a new merchant (root tenant)
// ---------------------------------------------------------------------------
export async function insert(db: DbOrTx, record: NewMerchant): Promise<Merchant> {
  const [row] = await db.insert(merchants).values(record).returning();
  if (!row) throw new Error("merchant.repo.insert: returning() yielded no row");
  return row;
}

// ---------------------------------------------------------------------------
// findById — primary lookup by merchant_id
// ---------------------------------------------------------------------------
export async function findById(db: DbOrTx, merchantId: string): Promise<Merchant | null> {
  const [row] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.merchantId, merchantId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// list — all merchants (operator/bootstrap use; unbounded — small table)
// ---------------------------------------------------------------------------
export async function list(db: DbOrTx): Promise<Merchant[]> {
  return db.select().from(merchants);
}
