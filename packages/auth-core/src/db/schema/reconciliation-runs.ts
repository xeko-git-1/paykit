/**
 * Drizzle schema for paykit.reconciliation_runs.
 * Audit trail for reconciliation worker invocations.
 */
import { jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const reconciliationRuns = paykitSchema.table("reconciliation_runs", {
  runId: uuid("run_id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  summaryJson: jsonb("summary_json"),
});

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type NewReconciliationRun = typeof reconciliationRuns.$inferInsert;

/**
 * The outcomes a reconciliation run can end in.
 *
 * `partial` and `skipped` exist because folding them into `failed` destroys the
 * only information the audit trail is there to carry. A run that reconciled four
 * providers and lost one still reconciled four; a run that found the lock already
 * held did no work and is not an error at all. With three states, contention and a
 * genuine failure look identical on a dashboard, and "was this window
 * reconciled?" becomes unanswerable.
 */
export type ReconciliationRunStatus = "running" | "completed" | "partial" | "failed" | "skipped";
