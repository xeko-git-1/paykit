/**
 * The reconciliation lock must live on ONE connection.
 *
 * A session-level advisory lock belongs to the backend session that took it, so
 * issuing acquire and release through a pool is not a small inefficiency — it is
 * two distinct bugs. The unlock lands on a session holding nothing and returns
 * false, leaving the lock held for the life of a pooled connection; and that
 * connection, still holding the lock, goes back to the pool where a later run can
 * be handed it and re-acquire successfully, because a session that already holds a
 * lock always gets it again. Two reconcilers then run at once.
 *
 * Neither failure is visible through the Drizzle query API, which is why these
 * tests drive a fake pool and assert on which connection each statement ran.
 */
import { describe, expect, it } from "vitest";
import {
  RECONCILE_LOCK_NAME,
  acquireReconcileLock,
  holdsReconcileLock,
  releaseReconcileLock,
  tryAcquireReconcileLock,
} from "../src/reconcile/advisory-lock.js";

interface Statement {
  readonly connectionId: number;
  readonly sql: string;
}

/**
 * A pool that hands out distinguishable connections and records every statement
 * against the connection it ran on — the only way to observe the pinning.
 *
 * `lockHeldBy` models PostgreSQL's actual rule: an acquire succeeds when the lock
 * is free OR when this same session already holds it.
 */
function fakePool(opts: { failUnlock?: boolean } = {}) {
  const statements: Statement[] = [];
  const released: number[] = [];
  const destroyed: number[] = [];
  let nextId = 1;
  let lockHeldBy: number | null = null;

  const pool = {
    async connect() {
      const connectionId = nextId++;
      return {
        async query(sql: string, _params?: unknown[]) {
          statements.push({ connectionId, sql });
          if (sql.includes("pg_try_advisory_lock")) {
            const acquired = lockHeldBy === null || lockHeldBy === connectionId;
            if (acquired) lockHeldBy = connectionId;
            return { rows: [{ acquired }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            if (opts.failUnlock === true) throw new Error("connection lost");
            // Only the holding session can release it.
            const unlocked = lockHeldBy === connectionId;
            if (unlocked) lockHeldBy = null;
            return { rows: [{ unlocked }] };
          }
          return { rows: [] };
        },
        release(destroy?: boolean) {
          if (destroy === true) {
            destroyed.push(connectionId);
            // Ending the session drops any lock it held.
            if (lockHeldBy === connectionId) lockHeldBy = null;
            return;
          }
          released.push(connectionId);
        },
      };
    },
  };

  return {
    db: { $client: pool } as never,
    statements,
    released,
    destroyed,
    isLockHeld: () => lockHeldBy !== null,
  };
}

describe("the lock is pinned to one connection", () => {
  it("acquires and releases on the SAME connection", async () => {
    const h = fakePool();
    const lease = await acquireReconcileLock(h.db);
    expect(lease).not.toBeNull();
    await lease?.release();

    const lockStatements = h.statements.filter((s) => s.sql.includes("advisory"));
    expect(lockStatements).toHaveLength(2);
    // The whole point: one connection id across both statements. Two ids here is
    // the defect — the unlock would run on a session holding nothing.
    expect(lockStatements[0]?.connectionId).toBe(lockStatements[1]?.connectionId);
  });

  it("actually releases the lock, so a later run can take it", async () => {
    const h = fakePool();
    const first = await acquireReconcileLock(h.db);
    await first?.release();
    expect(h.isLockHeld()).toBe(false);

    const second = await acquireReconcileLock(h.db);
    expect(second).not.toBeNull();
    await second?.release();
  });

  it("returns the connection to the pool in every outcome", async () => {
    const h = fakePool();
    const lease = await acquireReconcileLock(h.db);
    await lease?.release();
    expect(h.released).toContain(1);
  });

  it("returns the connection immediately when the lock is already held", async () => {
    const h = fakePool();
    const held = await acquireReconcileLock(h.db);
    expect(held).not.toBeNull();

    // A second acquire takes a different connection, so PostgreSQL refuses it.
    const blocked = await acquireReconcileLock(h.db);
    expect(blocked).toBeNull();
    // Not holding a connection hostage for a lock it did not get.
    expect(h.released).toContain(2);

    await held?.release();
  });

  it("uses the documented lock name, so it cannot collide with a consumer's own locks", async () => {
    const h = fakePool();
    const lease = await acquireReconcileLock(h.db);
    await lease?.release();
    expect(RECONCILE_LOCK_NAME).toBe("paykit.reconcile");
  });
});

describe("release is safe in a finally block", () => {
  it("is idempotent — a second release does not re-issue the unlock", async () => {
    const h = fakePool();
    const lease = await acquireReconcileLock(h.db);
    await lease?.release();
    await lease?.release();
    expect(h.statements.filter((s) => s.sql.includes("pg_advisory_unlock"))).toHaveLength(1);
  });

  it("destroys the connection when the unlock fails, rather than pooling a locked session", async () => {
    const h = fakePool({ failUnlock: true });
    const lease = await acquireReconcileLock(h.db);

    // Must not throw: this runs in the finally of a reconciliation run, where a
    // throw would replace the run's own error with this one.
    await expect(lease?.release()).resolves.toBeUndefined();

    // Returning it to the pool would leave a connection holding a lock nobody
    // tracks — and a later run handed that connection would re-acquire it.
    expect(h.destroyed).toContain(1);
    expect(h.released).not.toContain(1);
    expect(h.isLockHeld()).toBe(false);
  });
});

describe("the boolean acquire/release pair", () => {
  it("reports success and then releases", async () => {
    const h = fakePool();
    expect(await tryAcquireReconcileLock(h.db)).toBe(true);
    expect(holdsReconcileLock(h.db)).toBe(true);
    await releaseReconcileLock(h.db);
    expect(holdsReconcileLock(h.db)).toBe(false);
    expect(h.isLockHeld()).toBe(false);
  });

  it("refuses a second acquire while this process holds the lock", async () => {
    const h = fakePool();
    expect(await tryAcquireReconcileLock(h.db)).toBe(true);
    // Reporting true here would hand the lock out twice while only one release
    // exists to give it back.
    expect(await tryAcquireReconcileLock(h.db)).toBe(false);
    await releaseReconcileLock(h.db);
  });

  it("release is a no-op when nothing is held", async () => {
    const h = fakePool();
    await expect(releaseReconcileLock(h.db)).resolves.toBeUndefined();
    expect(h.statements).toHaveLength(0);
  });
});

describe("a client that cannot pin a connection", () => {
  it("fails loudly instead of taking a lock it cannot release", async () => {
    // Silently degrading to pool-issued statements is what the old code did, and
    // it is worse than an error: the lock looks taken and never comes back.
    await expect(acquireReconcileLock({} as never)).rejects.toThrow(/does not expose a pg Pool/);
  });
});
