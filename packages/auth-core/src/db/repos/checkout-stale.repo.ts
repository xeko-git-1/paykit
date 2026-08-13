/**
 * checkout-stale.repo — expiring checkouts the customer walked away from.
 *
 * A checkout that was created but never paid sits in `provider_creating` /
 * `awaiting_payment` (or historical `pending`) forever unless the provider
 * sends an expiry webhook — and not every rail does. The row itself is only
 * clutter, but the discount reservation it may hold is not: a reservation
 * counts against the promo cap, so an abandoned checkout that is never expired
 * silently shrinks the discount budget for everyone else.
 *
 * The flip to `expired` is a guarded UPDATE keyed on the stale statuses, so a
 * webhook that completes the payment concurrently wins the race: either the
 * webhook's transaction moved the row out of the stale set first (this update
 * skips it), or this update moved it to `expired` first (the webhook's
 * completed-handler sees a non-awaiting status and deliberately does not
 * credit — same behavior as a provider-side expiry).
 *
 * The TTL must therefore be longer than the longest provider checkout
 * validity, or a slow-but-legitimate payment could land on an expired row and
 * not credit. The default lives in the sweeper (48h); this repo just executes
 * whatever cutoff it is given.
 */
import { and, inArray, lte, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type PaymentTransaction, paymentTransactions } from "../schema/payment-transactions.js";

/**
 * The statuses a stale sweep may expire.
 *
 * `pending` and `awaiting_payment` are the same state in two spellings (see the
 * schema comment). `provider_creating` is included because after the TTL the
 * "a session may exist upstream" ambiguity is resolved by time: no provider
 * keeps a checkout session open for days, so the reconcile the state was
 * waiting for is never going to change the answer.
 */
export const STALE_CHECKOUT_STATUSES = [
  "pending",
  "provider_creating",
  "awaiting_payment",
] as const;

/**
 * Move checkouts created before `cutoff` and still unpaid to `expired`.
 *
 * FOR UPDATE SKIP LOCKED + re-asserted status under the lock, same shape as the
 * refund-overdue marker: several instances sweeping concurrently divide the
 * rows instead of double-processing them. Returns the rows THIS call expired,
 * with metadata intact, so the caller can release discount reservations in the
 * same transaction.
 */
export async function expireStaleCheckouts(
  db: DbOrTx,
  opts: { cutoff: Date; limit?: number },
): Promise<PaymentTransaction[]> {
  const limit = opts.limit ?? 50;
  const staleStatuses = [...STALE_CHECKOUT_STATUSES];
  const candidate = sql`(
    SELECT ${paymentTransactions.transactionId} FROM ${paymentTransactions}
    WHERE ${paymentTransactions.status} IN ('pending', 'provider_creating', 'awaiting_payment')
      AND ${paymentTransactions.createdAt} <= ${opts.cutoff}
    ORDER BY ${paymentTransactions.createdAt}
    FOR UPDATE SKIP LOCKED
    LIMIT ${limit}
  )`;

  return db
    .update(paymentTransactions)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        sql`${paymentTransactions.transactionId} IN ${candidate}`,
        // Re-assert under the row lock: the sub-select ran before it was taken,
        // and a completing webhook may have moved the row in between.
        inArray(paymentTransactions.status, staleStatuses),
        lte(paymentTransactions.createdAt, opts.cutoff),
      ),
    )
    .returning();
}
