/**
 * Applies compliance screening verdicts to payments that are parked in
 * `screening_pending`.
 *
 * The whole reason this module exists is the transaction boundary. Screening is
 * an outbound HTTP call to a tenant-supplied third party; calling it while
 * holding a `SELECT ... FOR UPDATE` lock on the payment row means one slow
 * provider pins a row lock and a pooled connection for the full request
 * latency, and every redelivery of the same webhook queues behind it. So the
 * work is split into three phases with the network call between two short
 * transactions, never inside one:
 *
 *   webhook tx : settle the amount, park the payment in `screening_pending`,
 *                enqueue a job, COMMIT  (releases the row lock)
 *   this step  : claim a job, call the screening service under a timeout
 *   verdict tx : credit or quarantine, then record the verdict
 *
 * Correctness of the split rests on the parked state being durable: if this
 * process dies at any point, the payment is still `screening_pending` with a
 * claimable job, so the work resumes rather than being lost. The alternative —
 * holding everything in one transaction — is only "safe" while the process
 * lives.
 */
import type { ScreeningDecision, ScreeningService } from "@vibecc/paykit";
import { ScreeningUnavailableError } from "@vibecc/paykit";
import type { DbClient } from "@vibecc/paykit-auth-core/db/client.js";
import { applyDelta } from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import {
  commitReservation,
  releaseReservation,
} from "@vibecc/paykit-auth-core/db/repos/discount.repo.js";
import { appendLedgerEntryIdempotent } from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import { findByProviderRef } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import {
  claimNextScreeningJob,
  markScreeningDecided,
  markScreeningRetryable,
} from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
import type { ScreeningJob } from "@vibecc/paykit-auth-core/db/schema/screening-jobs.js";
import type { PaykitEventHandlers } from "../events/emitter.js";
import { emitEvent } from "../events/emitter.js";
import {
  MAX_SCREENING_ATTEMPTS,
  screeningAttemptsExhausted,
  screeningRetryDelayMs,
} from "./screening-backoff.js";
import { creditScreenedPayment, quarantineScreenedPayment } from "./screening-verdict-tx.js";

export interface ScreeningRunnerDeps {
  readonly db: DbClient;
  readonly screeningService: ScreeningService;
  /**
   * Lifecycle handlers. `payment.completed` fires from here rather than from the
   * webhook when screening is configured: the webhook only parks the payment, so
   * at that point there is nothing to announce. A consumer listening for
   * completion must still hear about a payment that screening later cleared.
   */
  readonly events?: PaykitEventHandlers;
  /**
   * Bound on one screening call. A tenant service that never returns would
   * otherwise hold its claim until the lease expires and then be retried
   * forever, making no progress.
   */
  readonly callTimeoutMs?: number;
  /** Must exceed `callTimeoutMs`, else a healthy slow call loses its claim. */
  readonly leaseMs?: number;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  /** Injectable for deterministic backoff assertions in tests. */
  readonly random?: () => number;
  readonly now?: () => Date;
}

const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** What happened to one job — returned so a caller/test can assert progress. */
export type ScreeningJobOutcome =
  | { readonly result: "credited"; readonly transactionId: string }
  | { readonly result: "quarantined"; readonly transactionId: string; readonly reason: string }
  | { readonly result: "manual_review"; readonly transactionId: string; readonly reason: string }
  | {
      readonly result: "retry_scheduled";
      readonly transactionId: string;
      readonly nextAttemptAt: Date;
    }
  | { readonly result: "idle" };

function leaseFor(deps: ScreeningRunnerDeps, callTimeoutMs: number): number {
  // Default the lease to comfortably outlast the call so a slow-but-alive
  // screening is not preempted by its own retry.
  return deps.leaseMs ?? callTimeoutMs * 3;
}

/**
 * Run one screening call under a timeout.
 *
 * A rejected promise means "no verdict" and is handled as retryable. The timer
 * is always cleared: leaking it would keep the process alive on shutdown.
 */
async function callWithTimeout(
  deps: ScreeningRunnerDeps,
  job: ScreeningJob,
  timeoutMs: number,
): Promise<ScreeningDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.screeningService({
        transactionId: job.transactionId,
        tenantId: job.tenantId,
        provider: job.provider,
        amountMicros: job.creditMicros,
        currencyCode: job.currencyCode,
        event: (job.eventJson ?? {}) as Record<string, unknown>,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ScreeningUnavailableError(
                `screening service did not answer within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Claim and process at most one due job. Returns `idle` when the queue has
 * nothing due, so a caller can back off instead of spinning.
 */
export async function processNextScreeningJob(
  deps: ScreeningRunnerDeps,
): Promise<ScreeningJobOutcome> {
  const now = deps.now ?? (() => new Date());
  const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  const job = await claimNextScreeningJob(deps.db, {
    leaseMs: leaseFor(deps, callTimeoutMs),
    now: now(),
  });
  if (job === undefined) return { result: "idle" };

  let decision: ScreeningDecision;
  try {
    decision = await callWithTimeout(deps, job, callTimeoutMs);
  } catch (err) {
    return scheduleRetry(deps, job, err);
  }

  if (decision.verdict === "clear") {
    // Credit and verdict are recorded in ONE transaction: a crash between them
    // would otherwise either credit a payment whose job still looks claimable
    // (double credit risk, bounded only by the ledger unique index) or mark a
    // job cleared without the money having moved.
    const { applied } = await creditScreenedPayment(deps.db, job, {
      appendLedgerEntryIdempotent,
      applyDelta,
      markScreeningDecided,
      commitReservation,
      releaseReservation,
      now: now(),
    });
    deps.emitMetric?.("paykit_credit_screened_total", { provider: job.provider });
    // Emitted only when this caller won the status transition. A duplicated
    // verdict is a no-op on the money, so it has to be a no-op on the event too:
    // a consumer that fulfils an order on payment.completed would otherwise
    // fulfil it twice.
    if (applied) await emitCompleted(deps, job);
    return { result: "credited", transactionId: job.transactionId };
  }

  // reject and manual_review are both terminal for the credit path and both
  // quarantine the payment; they differ in the audit trail and the metric, so a
  // human queue can be built on `manual_review` without scanning reasons.
  const terminalState = decision.verdict === "reject" ? "rejected" : "manual_review";
  await quarantineScreenedPayment(deps.db, job, {
    state: terminalState,
    reason: decision.reason,
    markScreeningDecided,
    commitReservation,
    releaseReservation,
    now: now(),
  });

  if (terminalState === "rejected") {
    deps.logger?.warn("screening rejected payment — quarantined without credit", {
      provider: job.provider,
      transactionId: job.transactionId,
      reason: decision.reason,
    });
    // Metric name preserved from the inline hook so existing dashboards and
    // alerts keep working across this change.
    deps.emitMetric?.("paykit_credit_blocked_total", { provider: job.provider });
    return { result: "quarantined", transactionId: job.transactionId, reason: decision.reason };
  }

  deps.logger?.warn("screening needs manual review — quarantined without credit", {
    provider: job.provider,
    transactionId: job.transactionId,
    reason: decision.reason,
  });
  deps.emitMetric?.("paykit_credit_manual_review_total", { provider: job.provider });
  return { result: "manual_review", transactionId: job.transactionId, reason: decision.reason };
}

/**
 * Handle a screening that produced no verdict.
 *
 * The payment stays `screening_pending` — never credited on an absent answer.
 * Once attempts run out the job becomes a human decision rather than retrying
 * forever or, worse, defaulting to credit.
 */
async function scheduleRetry(
  deps: ScreeningRunnerDeps,
  job: ScreeningJob,
  err: unknown,
): Promise<ScreeningJobOutcome> {
  const now = deps.now ?? (() => new Date());
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof ScreeningUnavailableError ? err.code : "SCREENING_CALL_FAILED";

  if (screeningAttemptsExhausted(job.attempts)) {
    const reason = `screening inconclusive after ${MAX_SCREENING_ATTEMPTS} attempts: ${message}`;
    await quarantineScreenedPayment(deps.db, job, {
      state: "manual_review",
      reason,
      markScreeningDecided,
      commitReservation,
      releaseReservation,
      now: now(),
    });
    deps.logger?.warn("screening exhausted retries — quarantined for manual review", {
      provider: job.provider,
      transactionId: job.transactionId,
      attempts: job.attempts,
      reason: message,
    });
    deps.emitMetric?.("paykit_screening_exhausted_total", { provider: job.provider });
    return { result: "manual_review", transactionId: job.transactionId, reason };
  }

  const delayMs = screeningRetryDelayMs(job.attempts, deps.random);
  const nextAttemptAt = new Date(now().getTime() + delayMs);
  await markScreeningRetryable(deps.db, {
    jobId: job.jobId,
    nextAttemptAt,
    errorCode: code,
    errorMessage: message,
    now: now(),
  });
  deps.logger?.warn("screening inconclusive — retry scheduled, payment left uncredited", {
    provider: job.provider,
    transactionId: job.transactionId,
    attempts: job.attempts,
    nextAttemptAt: nextAttemptAt.toISOString(),
    error: message,
  });
  deps.emitMetric?.("paykit_screening_retry_total", { provider: job.provider });
  return { result: "retry_scheduled", transactionId: job.transactionId, nextAttemptAt };
}

/**
 * Announce a screened payment as completed, after its credit transaction has
 * committed.
 *
 * The row is re-read rather than reconstructed from the job: handlers receive the
 * persisted transaction, and its status is only `completed` once the verdict
 * transaction landed. Reading it here also means the handler cannot observe a
 * payment that a rolled-back transaction never credited.
 *
 * `emitEvent` already swallows handler throws, and a missing row is treated as
 * nothing to announce — neither can undo money that is already committed.
 */
async function emitCompleted(deps: ScreeningRunnerDeps, job: ScreeningJob): Promise<void> {
  if (deps.events === undefined) return;
  const row = await findByProviderRef(deps.db, job.provider, job.sourceId);
  if (row === undefined) return;
  await emitEvent(
    deps.events,
    { type: "payment.completed", transaction: row },
    deps.logger ?? { warn: () => {} },
  );
}

/**
 * Drain due jobs until the queue is idle or `maxJobs` is reached. Bounded so a
 * caller (cron tick, admin trigger) cannot be held indefinitely by a queue that
 * is being refilled as fast as it drains.
 */
export async function drainScreeningJobs(
  deps: ScreeningRunnerDeps,
  maxJobs = 50,
): Promise<ScreeningJobOutcome[]> {
  const outcomes: ScreeningJobOutcome[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const outcome = await processNextScreeningJob(deps);
    if (outcome.result === "idle") break;
    outcomes.push(outcome);
  }
  return outcomes;
}
