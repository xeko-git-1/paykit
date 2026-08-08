/**
 * The mutex that keeps two reconciliation runs from overlapping.
 *
 * A PostgreSQL session-level advisory lock belongs to the *backend session* that
 * took it, and it is released only by an explicit unlock on that same session or
 * when the session ends. Nothing about it respects transaction boundaries.
 *
 * That makes it unusable through a connection pool the way this module used to
 * use it. `pool.query(...)` picks whichever connection is idle, so acquire and
 * release land on two different sessions, and two things follow:
 *
 *   - The unlock runs on a session that holds nothing. It returns false and the
 *     lock stays held for as long as the original connection lives — which, for
 *     a pooled connection, is indefinitely. Every later run is locked out.
 *   - Worse, the connection still holding the lock goes back to the pool. When a
 *     later run happens to be handed that same connection, its acquire SUCCEEDS,
 *     because a session that already holds a lock always re-acquires it. Two
 *     reconcilers then run at once, which is the exact thing the lock exists to
 *     prevent.
 *
 * So the lock is pinned: one connection is checked out of the pool, the lock is
 * taken on it, and it is held until the run releases it. Only the lock statements
 * go through that connection — the run's own queries keep using the pool, so a
 * long reconciliation does not tie up a connection doing nothing.
 */
import type { DbClient } from "@vibecc/paykit-server";
import type { Pool } from "pg";

export const RECONCILE_LOCK_NAME = "paykit.reconcile";

/**
 * A held lock. `release` is idempotent and never throws: it runs in the `finally`
 * of a reconciliation run, where masking the run's own error would hide the
 * reason the run failed.
 */
export interface ReconcileLockLease {
  release(): Promise<void>;
}

/**
 * The pool behind a Drizzle client.
 *
 * Drizzle exposes the driver it was constructed with as `$client`. Reaching for
 * it is deliberate: a correct session lock cannot be expressed through the
 * query-builder API, which has no concept of "the same connection as last time".
 */
function poolOf(db: DbClient): Pool {
  const pool = (db as unknown as { $client?: unknown }).$client;
  if (pool === undefined || pool === null || typeof (pool as Pool).connect !== "function") {
    throw new Error(
      "advisory lock: the database client does not expose a pg Pool, so the lock cannot be pinned to one connection",
    );
  }
  return pool as Pool;
}

/**
 * Take the reconciliation lock, or return null when another run holds it.
 *
 * Null means "someone else is reconciling" — a normal outcome, not a failure, and
 * callers are expected to report it as skipped rather than errored.
 */
export async function acquireReconcileLock(db: DbClient): Promise<ReconcileLockLease | null> {
  const client = await poolOf(db).connect();
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [RECONCILE_LOCK_NAME],
    );
    acquired = result.rows[0]?.acquired === true;
  } catch (err) {
    // The connection must go back even when the acquire itself failed, or a
    // transient error permanently shrinks the pool.
    client.release();
    throw err;
  }

  if (!acquired) {
    client.release();
    return null;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [RECONCILE_LOCK_NAME]);
      } catch {
        // Unlocking failed, so destroy the connection instead of returning it to
        // the pool still holding the lock: a pooled connection that holds a lock
        // nobody tracks would re-acquire it successfully for a later run and let
        // two reconcilers run together. Ending the session releases the lock,
        // which is the outcome that matters.
        client.release(true);
        return;
      }
      client.release();
    },
  };
}

/**
 * Leases held per pool, so the older acquire/release pair below still works.
 *
 * Keyed by pool rather than kept in a single variable because one process can
 * legitimately talk to more than one database. Only a successfully acquired lock
 * is recorded, and only one can be held per pool at a time — a second acquire on
 * the same pool takes a different connection and therefore a different session,
 * so PostgreSQL refuses it.
 */
const leases = new WeakMap<Pool, ReconcileLockLease>();

/**
 * Take the lock, reporting success as a boolean.
 *
 * Kept because it is part of this package's public surface. Prefer
 * `acquireReconcileLock`: the lease it returns makes the pairing explicit, where
 * this pair relies on the caller reaching `releaseReconcileLock` with the same
 * client.
 */
export async function tryAcquireReconcileLock(db: DbClient): Promise<boolean> {
  const pool = poolOf(db);
  if (leases.has(pool)) {
    // Already held by this process. Reporting true would hand out the lock twice
    // and the release would then run once, leaving it held.
    return false;
  }
  const lease = await acquireReconcileLock(db);
  if (lease === null) return false;
  leases.set(pool, lease);
  return true;
}

/** Release a lock taken with `tryAcquireReconcileLock`. A no-op if none is held. */
export async function releaseReconcileLock(db: DbClient): Promise<void> {
  const pool = poolOf(db);
  const lease = leases.get(pool);
  if (lease === undefined) return;
  leases.delete(pool);
  await lease.release();
}

/** Test seam: whether this process currently holds the lock for `db`'s pool. */
export function holdsReconcileLock(db: DbClient): boolean {
  return leases.has(poolOf(db));
}
