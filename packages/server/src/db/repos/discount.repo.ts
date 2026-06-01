/**
 * discount.repo — tenant-scoped promo codes for the public checkout API.
 *
 * `findActiveByCode` resolves a code to its row (or undefined if absent).
 * `redeem` is the race-safe consume: it increments times_redeemed in a single
 * guarded UPDATE that only matches while the code is active, unexpired, and
 * below its redemption cap. Under concurrent checkouts, exactly one of the
 * final redemptions wins (RETURNING is empty for the loser), so a capped code
 * can never be over-redeemed.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type Discount, discounts } from "../schema/discounts.js";

export async function findActiveByCode(
  db: DbOrTx,
  tenantId: string,
  code: string,
  now: Date = new Date(),
): Promise<Discount | undefined> {
  const [row] = await db
    .select()
    .from(discounts)
    .where(and(eq(discounts.tenantId, tenantId), eq(discounts.code, code)))
    .limit(1);
  if (!row) return undefined;
  if (!row.active) return undefined;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return undefined;
  return row;
}

/**
 * Atomically redeem one unit of a discount. Returns true if redeemed, false if
 * the code was concurrently exhausted, expired, or deactivated. The WHERE guard
 * does the cap check inside the UPDATE so it is not a check-then-act race.
 */
export async function redeem(
  db: DbOrTx,
  discountId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(discounts)
    .set({
      timesRedeemed: sql`${discounts.timesRedeemed} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(discounts.discountId, discountId),
        eq(discounts.active, true),
        or(isNull(discounts.expiresAt), sql`${discounts.expiresAt} > ${now}`),
        or(
          isNull(discounts.maxRedemptions),
          lt(discounts.timesRedeemed, discounts.maxRedemptions),
        ),
      ),
    )
    .returning({ discountId: discounts.discountId });
  return rows.length > 0;
}
