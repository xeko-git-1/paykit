/**
 * discount.repo — tenant-scoped promo codes for the public checkout API.
 *
 * The cap counts COMPLETED payments, implemented as a reserve→commit/release
 * lifecycle so it stays race-safe and never over-grants:
 *   - reserve()  at checkout: reserved += 1 while reserved + times_redeemed <
 *                max_redemptions (NULL = unlimited). Bounds in-flight checkouts.
 *   - commitReservation() at payment.completed: times_redeemed += 1, reserved -= 1.
 *   - releaseReservation() at payment failed/expired or provider error:
 *                reserved -= 1, freeing the slot for another checkout.
 *
 * Each mutation is a single guarded UPDATE; the cap check lives in the WHERE so
 * it is never a check-then-act race (Postgres re-evaluates the guard against
 * the committed row after the row lock, under READ COMMITTED).
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
 * Reserve one unit of a discount at checkout. Returns true if reserved, false
 * if the code is concurrently exhausted (reserved + redeemed already at cap),
 * expired, or deactivated. The guard counts BOTH committed redemptions and
 * outstanding reservations so concurrent checkouts cannot oversubscribe the cap.
 */
export async function reserve(
  db: DbOrTx,
  discountId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(discounts)
    .set({ reserved: sql`${discounts.reserved} + 1`, updatedAt: now })
    .where(
      and(
        eq(discounts.discountId, discountId),
        eq(discounts.active, true),
        or(isNull(discounts.expiresAt), sql`${discounts.expiresAt} > ${now}`),
        or(
          isNull(discounts.maxRedemptions),
          lt(
            sql`${discounts.reserved} + ${discounts.timesRedeemed}`,
            discounts.maxRedemptions,
          ),
        ),
      ),
    )
    .returning({ discountId: discounts.discountId });
  return rows.length > 0;
}

/**
 * Commit a reservation when the payment completes: move one unit from reserved
 * to times_redeemed. Guarded by reserved > 0 so a double webhook (same payment)
 * cannot double-count — the second commit matches nothing and returns false.
 */
export async function commitReservation(
  db: DbOrTx,
  discountId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(discounts)
    .set({
      timesRedeemed: sql`${discounts.timesRedeemed} + 1`,
      reserved: sql`${discounts.reserved} - 1`,
      updatedAt: now,
    })
    .where(and(eq(discounts.discountId, discountId), sql`${discounts.reserved} > 0`))
    .returning({ discountId: discounts.discountId });
  return rows.length > 0;
}

/**
 * Release a reservation when the payment fails/expires or the provider checkout
 * could not be created, freeing the slot. Guarded by reserved > 0 so a double
 * release cannot drive the counter negative.
 */
export async function releaseReservation(
  db: DbOrTx,
  discountId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(discounts)
    .set({ reserved: sql`${discounts.reserved} - 1`, updatedAt: now })
    .where(and(eq(discounts.discountId, discountId), sql`${discounts.reserved} > 0`))
    .returning({ discountId: discounts.discountId });
  return rows.length > 0;
}
