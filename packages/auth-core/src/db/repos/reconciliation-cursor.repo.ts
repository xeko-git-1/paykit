/**
 * reconciliation-cursor.repo — read, advance and reset a provider's reconciliation
 * position, and read one bounded page of payments from it.
 *
 * The page query is here rather than in the worker because it is the half that must
 * be exactly right: a keyset predicate that is subtly wrong does not error, it
 * silently skips payments, and a skipped payment is precisely what reconciliation
 * exists to catch. Keeping it beside the cursor it reads means the predicate and
 * the stored position can only be changed together.
 */
import { and, asc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type PaymentTransaction, paymentTransactions } from "../schema/payment-transactions.js";
import {
  type ReconciliationCursor,
  reconciliationCursors,
} from "../schema/reconciliation-cursors.js";

export interface CursorWindow {
  readonly since: Date;
  readonly until: Date;
}

export async function findCursor(
  db: DbOrTx,
  provider: string,
): Promise<ReconciliationCursor | undefined> {
  const [row] = await db
    .select()
    .from(reconciliationCursors)
    .where(eq(reconciliationCursors.provider, provider))
    .limit(1);
  return row;
}

/**
 * The position a run should start from, given the window it was asked for.
 *
 * Returns undefined — meaning "start at the beginning of the window" — when there
 * is no cursor, when the stored cursor belongs to a different window, or when its
 * window was already finished. Resuming into a window the position was never walked
 * in would skip everything before it, so a window mismatch has to reset rather than
 * resume.
 */
export function resumePosition(
  cursor: ReconciliationCursor | undefined,
  window: CursorWindow,
): { readonly createdAt: Date; readonly transactionId: string } | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.exhausted) return undefined;
  if (cursor.lastCreatedAt === null || cursor.lastTransactionId === null) return undefined;
  if (cursor.windowSince === null || cursor.windowUntil === null) return undefined;
  if (
    cursor.windowSince.getTime() !== window.since.getTime() ||
    cursor.windowUntil.getTime() !== window.until.getTime()
  ) {
    return undefined;
  }
  return { createdAt: cursor.lastCreatedAt, transactionId: cursor.lastTransactionId };
}

/**
 * One page of payments in the window, after `after`, oldest first.
 *
 * The predicate is a true keyset comparison — `(created_at, transaction_id) >
 * (last_created_at, last_transaction_id)` expressed as an OR — rather than
 * `created_at > last_created_at`. Timestamps are not unique: several payments can
 * share one, and a page boundary landing inside such a group would drop the rest of
 * it with the simpler predicate. Ordering by both columns is what makes the
 * comparison total.
 */
export async function pageOfPayments(
  db: DbOrTx,
  opts: {
    provider: string;
    window: CursorWindow;
    after?: { createdAt: Date; transactionId: string };
    limit: number;
  },
): Promise<PaymentTransaction[]> {
  const inWindow = and(
    eq(paymentTransactions.provider, opts.provider),
    gte(paymentTransactions.createdAt, opts.window.since),
    lt(paymentTransactions.createdAt, opts.window.until),
  );

  const after = opts.after;
  const predicate =
    after === undefined
      ? inWindow
      : and(
          inWindow,
          or(
            sql`${paymentTransactions.createdAt} > ${after.createdAt}`,
            and(
              eq(paymentTransactions.createdAt, after.createdAt),
              sql`${paymentTransactions.transactionId} > ${after.transactionId}`,
            ),
          ),
        );

  return db
    .select()
    .from(paymentTransactions)
    .where(predicate)
    .orderBy(asc(paymentTransactions.createdAt), asc(paymentTransactions.transactionId))
    .limit(opts.limit);
}

/**
 * Record how far this provider got.
 *
 * Written after the batch has been diffed, never before: a cursor advanced ahead of
 * the work would mark payments reconciled that nobody looked at, which is worse than
 * not advancing at all — the next run would skip straight past them.
 */
export async function advanceCursor(
  db: DbOrTx,
  opts: {
    provider: string;
    window: CursorWindow;
    position: { createdAt: Date; transactionId: string };
    exhausted: boolean;
    now?: Date;
  },
): Promise<ReconciliationCursor | undefined> {
  const now = opts.now ?? new Date();
  // Spelled out rather than read back off the insert values: with
  // exactOptionalPropertyTypes those are optional, and an accidental `undefined`
  // reaching a SET clause writes nothing while looking like it wrote.
  const position = {
    lastCreatedAt: opts.position.createdAt,
    lastTransactionId: opts.position.transactionId,
    windowSince: opts.window.since,
    windowUntil: opts.window.until,
    exhausted: opts.exhausted,
    updatedAt: now,
  };
  const [row] = await db
    .insert(reconciliationCursors)
    .values({ provider: opts.provider, ...position })
    .onConflictDoUpdate({
      target: reconciliationCursors.provider,
      set: position,
    })
    .returning();
  return row;
}

/**
 * Mark a window finished without moving the position.
 *
 * Used when a window turns out to hold nothing: there is no row to point at, but the
 * window still must not be re-walked on every subsequent invocation.
 */
export async function markWindowExhausted(
  db: DbOrTx,
  opts: { provider: string; window: CursorWindow; now?: Date },
): Promise<ReconciliationCursor | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .insert(reconciliationCursors)
    .values({
      provider: opts.provider,
      windowSince: opts.window.since,
      windowUntil: opts.window.until,
      exhausted: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: reconciliationCursors.provider,
      set: {
        windowSince: opts.window.since,
        windowUntil: opts.window.until,
        exhausted: true,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

/**
 * Forget a provider's position entirely, so the next run re-walks its window.
 *
 * The operator escape hatch for a cursor that advanced past work which turned out
 * not to have been reconciled — a bug, or a manual repair upstream.
 */
export async function resetCursor(db: DbOrTx, provider: string): Promise<void> {
  await db.delete(reconciliationCursors).where(eq(reconciliationCursors.provider, provider));
}
