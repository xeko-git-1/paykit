/**
 * screening-job.repo — enqueue, claim and decide compliance screening jobs.
 *
 * Every mutation is a single guarded UPDATE whose precondition lives in the
 * WHERE clause, so no step is a check-then-act race: Postgres re-evaluates the
 * guard against the committed row after taking the row lock under READ
 * COMMITTED. Two workers racing the same job therefore produce one winner and
 * one no-op, without any advisory lock or table lock.
 */
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import {
  type NewScreeningJob,
  type ScreeningDecidedState,
  type ScreeningJob,
  type ScreeningJobState,
  screeningJobs,
} from "../schema/screening-jobs.js";

export interface EnqueueScreeningJobInput {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly sourceId: string;
  readonly creditMicros: string;
  readonly currencyCode: string;
  readonly eventJson?: Record<string, unknown>;
}

/**
 * Enqueue a screening for a payment. Idempotent via UNIQUE (transaction_id): a
 * resent webhook, or two instances handling a redelivery concurrently, yields
 * one job. `enqueued` is false when a job already existed, which lets the caller
 * distinguish "I created this" from "someone already did" without a prior SELECT.
 */
export async function enqueueScreeningJob(
  db: DbOrTx,
  data: EnqueueScreeningJobInput,
): Promise<{ job: ScreeningJob; enqueued: boolean }> {
  const insert: NewScreeningJob = {
    transactionId: data.transactionId,
    tenantId: data.tenantId,
    ownerId: data.ownerId,
    provider: data.provider,
    sourceId: data.sourceId,
    creditMicros: data.creditMicros,
    currencyCode: data.currencyCode,
    eventJson: data.eventJson ?? {},
  };
  const [row] = await db
    .insert(screeningJobs)
    .values(insert)
    .onConflictDoNothing({ target: screeningJobs.transactionId })
    .returning();
  if (row) return { job: row, enqueued: true };

  const [existing] = await db
    .select()
    .from(screeningJobs)
    .where(eq(screeningJobs.transactionId, data.transactionId))
    .limit(1);
  if (!existing) {
    throw new Error("enqueueScreeningJob: post-conflict fetch returned no row");
  }
  return { job: existing, enqueued: false };
}

/**
 * Claim one due job for processing, or return undefined when nothing is due.
 *
 * Claimable means: `pending` and due, or `in_progress` whose lease has expired
 * (the worker holding it died — without this the job would never be retried).
 * The UPDATE ... RETURNING is itself the claim, so the row is fenced by the
 * `state`/`lease` predicate rather than by an application-level lock: a second
 * worker running the same statement matches zero rows.
 *
 * `leaseMs` should exceed the screening call's own timeout, otherwise a slow but
 * healthy call can have its lease stolen while still in flight.
 */
export async function claimNextScreeningJob(
  db: DbOrTx,
  opts: { leaseMs: number; now?: Date },
): Promise<ScreeningJob | undefined> {
  const now = opts.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + opts.leaseMs);

  // Sub-select picks a single candidate; FOR UPDATE SKIP LOCKED keeps concurrent
  // workers from queueing on the same row only to find the guard already false.
  const candidate = sql`(
    SELECT ${screeningJobs.jobId} FROM ${screeningJobs}
    WHERE (
      (${screeningJobs.state} = 'pending' AND ${screeningJobs.nextAttemptAt} <= ${now})
      OR (${screeningJobs.state} = 'in_progress' AND ${screeningJobs.leaseExpiresAt} <= ${now})
    )
    ORDER BY ${screeningJobs.nextAttemptAt}
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )`;

  const [row] = await db
    .update(screeningJobs)
    .set({
      state: "in_progress",
      attempts: sql`${screeningJobs.attempts} + 1`,
      leaseExpiresAt: leaseUntil,
      updatedAt: now,
    })
    .where(
      and(
        eq(screeningJobs.jobId, candidate),
        // Re-assert the claimability predicate: the sub-select ran before the row
        // lock, so between the two a competing worker may already have claimed it.
        or(
          and(eq(screeningJobs.state, "pending"), lte(screeningJobs.nextAttemptAt, now)),
          and(
            eq(screeningJobs.state, "in_progress"),
            isNotNull(screeningJobs.leaseExpiresAt),
            lte(screeningJobs.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  return row;
}

/**
 * Record a terminal verdict. Guarded on `in_progress` so only the worker holding
 * the claim can decide, and so a late verdict from a worker whose lease expired
 * cannot overwrite the decision its replacement already wrote.
 */
export async function markScreeningDecided(
  db: DbOrTx,
  opts: {
    jobId: string;
    state: ScreeningDecidedState;
    reason?: string;
    now?: Date;
  },
): Promise<ScreeningJob | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(screeningJobs)
    .set({
      state: opts.state,
      decidedAt: now,
      decisionReason: opts.reason ?? null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(screeningJobs.jobId, opts.jobId), eq(screeningJobs.state, "in_progress")))
    .returning();
  return row;
}

/**
 * Release a job for another attempt after an inconclusive screening (timeout,
 * service unavailable, unusable answer). `nextAttemptAt` carries the backoff the
 * caller computed. Guarded on `in_progress` for the same fencing reason as
 * `markScreeningDecided`.
 */
export async function markScreeningRetryable(
  db: DbOrTx,
  opts: {
    jobId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorMessage: string;
    now?: Date;
  },
): Promise<ScreeningJob | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(screeningJobs)
    .set({
      state: "pending",
      nextAttemptAt: opts.nextAttemptAt,
      leaseExpiresAt: null,
      lastErrorCode: opts.errorCode,
      lastErrorMessage: opts.errorMessage,
      updatedAt: now,
    })
    .where(and(eq(screeningJobs.jobId, opts.jobId), eq(screeningJobs.state, "in_progress")))
    .returning();
  return row;
}

export async function findScreeningJobByTransaction(
  db: DbOrTx,
  transactionId: string,
): Promise<ScreeningJob | undefined> {
  const [row] = await db
    .select()
    .from(screeningJobs)
    .where(eq(screeningJobs.transactionId, transactionId))
    .limit(1);
  return row;
}

/** Jobs awaiting a human decision — surfaced for an admin review queue. */
export async function listScreeningJobsByState(
  db: DbOrTx,
  states: readonly ScreeningJobState[],
  limit = 50,
): Promise<ScreeningJob[]> {
  return db
    .select()
    .from(screeningJobs)
    .where(inArray(screeningJobs.state, [...states]))
    .orderBy(screeningJobs.createdAt)
    .limit(limit);
}
