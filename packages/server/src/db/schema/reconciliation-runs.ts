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
