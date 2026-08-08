/**
 * Drizzle schema for paykit.reconciliation_cursors — how far each provider has
 * been reconciled.
 *
 * The cursor exists so a window larger than one invocation can still be finished.
 * Without it, a run that dies partway starts the same window from the beginning
 * next time and dies in the same place, which means a window big enough to fail is
 * a window that can never be reconciled at all.
 *
 * The position is a keyset — `(lastCreatedAt, lastTransactionId)` — not an offset.
 * Rows are inserted while reconciliation runs, so `OFFSET n` means "skip the first
 * n rows as they are now" and a row arriving mid-run shifts the window past a
 * payment that then never gets checked. Skipping a payment is the one outcome a
 * reconciler must never produce.
 */
import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const reconciliationCursors = paykitSchema.table("reconciliation_cursors", {
  /** One cursor per provider — the position outlives any single run. */
  provider: text("provider").primaryKey(),

  // Both or neither: a single column cannot be used as a keyset, and half a
  // position would silently degrade to "start from the beginning" on a path that
  // believes it is resuming.
  lastCreatedAt: timestamp("last_created_at", { withTimezone: true }),
  lastTransactionId: uuid("last_transaction_id"),

  /**
   * The window this position belongs to. A cursor only means something relative to
   * its window: when a run asks for a different `since`, the stored position is
   * stale and the run starts fresh rather than resuming into a window it never
   * walked.
   */
  windowSince: timestamp("window_since", { withTimezone: true }),
  windowUntil: timestamp("window_until", { withTimezone: true }),

  /**
   * Whether the window was walked to the end. Without this, a completed window
   * would be re-walked from its final position — reconciling nothing, forever.
   */
  exhausted: boolean("exhausted").notNull().default(false),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReconciliationCursor = typeof reconciliationCursors.$inferSelect;
export type NewReconciliationCursor = typeof reconciliationCursors.$inferInsert;
