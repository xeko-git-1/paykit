/**
 * reconciliation.repo — start/complete reconciliation_runs rows.
 */
import { desc, eq } from "drizzle-orm";
import type { DbClient, DbOrTx } from "../client.js";
import {
  type NewReconciliationRun,
  type ReconciliationRun,
  type ReconciliationRunStatus,
  reconciliationRuns,
} from "../schema/reconciliation-runs.js";

export async function startRun(db: DbOrTx, startedAt: Date): Promise<ReconciliationRun> {
  const insert: NewReconciliationRun = { startedAt, status: "running" };
  const [row] = await db.insert(reconciliationRuns).values(insert).returning();
  if (!row) throw new Error("startRun: INSERT RETURNING produced no row");
  return row;
}

/**
 * Close a run with the status it actually reached.
 *
 * `partial` and `skipped` are distinct outcomes and must not be folded into
 * `failed`. A run that reconciled four providers and lost one is not the same as a
 * run that reconciled nothing, and a run that found the lock held did no work at
 * all — reporting either as `failed` makes the audit trail unable to answer
 * "was this window reconciled?", and makes contention indistinguishable from a
 * genuine error on a dashboard.
 */
export async function completeRun(
  db: DbOrTx,
  runId: string,
  status: Exclude<ReconciliationRunStatus, "running">,
  summaryJson: Record<string, unknown>,
): Promise<ReconciliationRun | undefined> {
  const [row] = await db
    .update(reconciliationRuns)
    .set({ status, summaryJson, completedAt: new Date() })
    .where(eq(reconciliationRuns.runId, runId))
    .returning();
  return row;
}

export async function listRuns(
  db: DbClient,
  opts: { limit?: number; offset?: number } = {},
): Promise<ReconciliationRun[]> {
  return db.query.reconciliationRuns.findMany({
    orderBy: [desc(reconciliationRuns.startedAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  });
}
