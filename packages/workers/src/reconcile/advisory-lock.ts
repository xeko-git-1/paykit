/**
 * Postgres advisory lock helper for reconciliation worker.
 *
 * Uses session-scoped `pg_try_advisory_lock(int8)`; lock auto-releases on
 * disconnect. Concurrent invocations skip cleanly without crash.
 *
 * Lock key derived from `hashtext('paykit.reconcile')` to avoid colliding with
 * consumer's own advisory locks.
 */
import type { DbClient } from "@vibecc/paykit-server";
import { sql } from "drizzle-orm";

export const RECONCILE_LOCK_NAME = "paykit.reconcile";

export async function tryAcquireReconcileLock(db: DbClient): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT pg_try_advisory_lock(hashtext(${RECONCILE_LOCK_NAME})) AS acquired`,
  );
  // node-pg returns array-like result via execute. Drizzle wraps as { rows: [...] }.
  const first = (rows as unknown as { rows?: Array<{ acquired: boolean }> }).rows?.[0];
  return Boolean(first?.acquired);
}

export async function releaseReconcileLock(db: DbClient): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${RECONCILE_LOCK_NAME}))`);
}
