/**
 * Drizzle schema for paykit.screening_jobs — the durable handoff between the
 * webhook transaction that received a payment and the worker that calls the
 * tenant's compliance screening service.
 *
 * The job exists because the screening call is an external HTTP request and must
 * not run inside the crediting transaction: doing so holds a `FOR UPDATE` row
 * lock and a pooled connection for the full latency of a third-party service.
 * The payment rests in `screening_pending` until a verdict lands.
 *
 * State machine:
 *   pending       → enqueued, waiting for a worker
 *   in_progress   → claimed under a lease; released back to pending if the lease
 *                   expires (worker died mid-call)
 *   cleared       → screening approved; payment credited
 *   rejected      → screening declined; payment quarantined
 *   manual_review → attempts exhausted without a verdict; a human decides.
 *                   Terminal for the worker, never auto-credited.
 *
 * UNIQUE (transaction_id) makes enqueue idempotent: a resent webhook or a
 * concurrent redelivery conflicts instead of screening the same payment twice.
 */
import { integer, jsonb, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const screeningJobs = paykitSchema.table(
  "screening_jobs",
  {
    jobId: uuid("job_id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    provider: text("provider").notNull(),
    // Ledger idempotency key for the eventual credit, so the worker writes the
    // same (provider, source_id, entry_type) the inline credit path would have.
    sourceId: text("source_id").notNull(),
    eventJson: jsonb("event_json").notNull().default({}),
    // Amount frozen at webhook time. Re-deriving it at verdict time could reach a
    // different answer (an overpaid transfer credits the requested amount, not
    // the received one), so the decision travels with the job.
    creditMicros: numeric("credit_micros", { precision: 30, scale: 0 }).notNull(),
    currencyCode: text("currency_code").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One screening per payment — the enqueue idempotency key.
    transactionUq: unique().on(table.transactionId),
  }),
);

export type ScreeningJob = typeof screeningJobs.$inferSelect;
export type NewScreeningJob = typeof screeningJobs.$inferInsert;

/** States a screening job can hold. */
export type ScreeningJobState =
  | "pending"
  | "in_progress"
  | "cleared"
  | "rejected"
  | "manual_review";

/**
 * The subset a worker may write as a verdict — every state except the two the
 * queue owns. Derived rather than restated so adding a state to the machine
 * forces a decision about whether a verdict can land in it, instead of silently
 * leaving the terminal set behind.
 */
export type ScreeningDecidedState = Exclude<ScreeningJobState, "pending" | "in_progress">;
