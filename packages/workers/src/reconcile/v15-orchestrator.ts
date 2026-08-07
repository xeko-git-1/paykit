/**
 * V1.5 reconcile orchestrator — registry-based.
 *
 * Iterates over all adapters in the ProviderRegistry; for each, calls
 * `adapter.fetchTransactions(window)` and diffs against paykit's snapshot.
 *
 * Run status carries four distinct outcomes, because an operator reading the audit
 * trail has to be able to tell them apart:
 *   - 'completed': every adapter reconciled
 *   - 'partial':   some adapters reconciled, some did not — the window is covered
 *                  except for the named providers
 *   - 'failed':    no adapter reconciled; the window was not covered at all and
 *                  the next run must cover it again
 *   - 'skipped':   another instance held the lock, so this invocation did no work.
 *                  Not an error: it is the expected outcome of running on a
 *                  schedule across several instances.
 *
 * Pending refunds (ZaloPay PROCESSING) polled in same run via `pollPendingRefunds`.
 */
import type { ProviderRegistry } from "@vibecc/paykit";
import {
  type DbClient,
  type PaymentTransaction,
  type ReconciliationRunStatus,
  balanceRepo,
  ledgerRepo,
  paymentTransactions,
  pendingRefundRepo,
  reconciliationRepo,
} from "@vibecc/paykit-server";
import { and, eq, gte, lt } from "drizzle-orm";
import { releaseReconcileLock, tryAcquireReconcileLock } from "./advisory-lock.js";
import { type PaykitTxnSnapshot, diffPaykitVsProvider } from "./differ.js";
import {
  EMPTY_PER_PROVIDER,
  type PerProviderStats,
  type ReconciliationSummary,
  summaryToJson,
} from "./summary.js";

export interface ReconcileV15Options {
  readonly since: Date;
  readonly until?: Date;
  readonly providerIds?: readonly string[]; // restrict to specific adapter ids
  readonly pendingRefundStaleAfterMs?: number; // default 5min
}

export interface ReconcileV15Deps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export interface ReconcileV15Result {
  readonly summary: ReconciliationSummary | null;
  readonly skipped: false | "lock_held";
  /**
   * What the run actually achieved.
   *
   * `skipped` is its own outcome, distinct from `failed`: another instance held
   * the lock, so this run did no work and nothing went wrong. Reporting it as
   * `failed` makes normal multi-instance contention page an operator, and makes
   * the alert that should fire on a real failure untrustworthy.
   */
  readonly status: Exclude<ReconciliationRunStatus, "running">;
}

const DEFAULT_PENDING_STALE_MS = 5 * 60 * 1000;
const PENDING_REFUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export async function reconcileV15(
  deps: ReconcileV15Deps,
  opts: ReconcileV15Options,
): Promise<ReconcileV15Result> {
  const { db, registry, logger } = deps;
  const since = opts.since;
  const until = opts.until ?? new Date();

  const acquired = await tryAcquireReconcileLock(db);
  if (!acquired) {
    return { summary: null, skipped: "lock_held", status: "skipped" };
  }

  // Opened before the try so the catch below can close it. A run row left in
  // `running` never resolves: it is indistinguishable from a run still in
  // progress, so the next invocation cannot tell whether this window was
  // reconciled, and a stuck-run alert built on `running` fires forever.
  const startedAt = new Date();
  const run = await reconciliationRepo.startRun(db, startedAt);

  try {
    // Snapshot paykit transactions in window (all providers)
    const paykitRows = (await db
      .select()
      .from(paymentTransactions)
      .where(
        and(gte(paymentTransactions.createdAt, since), lt(paymentTransactions.createdAt, until)),
      )) as PaymentTransaction[];

    const adapters = registry.list().filter((a) => {
      if (opts.providerIds === undefined) return true;
      return opts.providerIds.includes(a.id);
    });

    const perProvider: Record<string, PerProviderStats> = {};
    const allDiscrepancies = [];
    const adapterErrors: Record<string, string> = {};

    for (const adapter of adapters) {
      const snapshot = paykitRows
        .filter((r) => r.provider === adapter.id)
        .map<PaykitTxnSnapshot>((r) => ({
          transactionId: r.transactionId,
          providerRef: r.providerRef,
          amountMicros: r.amountMicros,
          currencyCode: r.currencyCode,
          status: r.status,
        }));

      try {
        const records = await adapter.fetchTransactions({ since, until });
        const result = diffPaykitVsProvider(adapter.id, snapshot, records);
        perProvider[adapter.id] = result.stats;
        allDiscrepancies.push(...result.discrepancies);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        adapterErrors[adapter.id] = msg;
        perProvider[adapter.id] = EMPTY_PER_PROVIDER;
        logger?.warn(`Reconciler: adapter '${adapter.id}' fetchTransactions failed`, {
          error: msg,
        });
      }
    }

    // Poll pending_refunds in same run
    const pendingResults = await pollPendingRefunds(deps, opts);

    // The run's outcome, distinguishing "some of it worked" from "none of it did".
    //
    // Every adapter failing is not the same as one failing: the first means the
    // window was not reconciled at all and the next run must cover it again, the
    // second means the window is reconciled except for one provider. Collapsing
    // both into one status leaves an operator unable to tell which happened.
    const failedAdapters = Object.keys(adapterErrors).length;
    const allAdaptersFailed = adapters.length > 0 && failedAdapters === adapters.length;
    const anythingFailed = failedAdapters > 0 || pendingResults.failed > 0;
    const runStatus: Exclude<ReconciliationRunStatus, "running" | "skipped"> = allAdaptersFailed
      ? "failed"
      : anythingFailed
        ? "partial"
        : "completed";

    const summary: ReconciliationSummary = {
      runId: run.runId,
      startedAt,
      completedAt: new Date(),
      // The status the run actually reached. This was hardcoded `completed`, so
      // the summary stored in the audit trail claimed success even for a run that
      // lost every provider.
      status: runStatus,
      window: { since, until },
      perProvider,
      discrepancies: allDiscrepancies,
    };

    const summaryJson = {
      ...summaryToJson(summary),
      v15: true,
      perProviderById: perProvider,
      adapterErrors,
      pendingRefunds: pendingResults,
    };

    // Stored as-is. Mapping `partial` onto `failed` here is what made a run that
    // reconciled four providers out of five indistinguishable from one that
    // reconciled nothing.
    await reconciliationRepo.completeRun(db, run.runId, runStatus, summaryJson);

    return { summary, skipped: false, status: runStatus };
  } catch (err) {
    // Close the run row before rethrowing. Without this the row stays `running`
    // for good: nothing else ever revisits it, so the audit trail shows a
    // reconciliation that started and never ended, and a monitor counting
    // in-flight runs climbs by one on every crash.
    try {
      await reconciliationRepo.completeRun(db, run.runId, "failed", {
        error: err instanceof Error ? err.message : String(err),
        window: { since: since.toISOString(), until: until.toISOString() },
      });
    } catch (closeErr) {
      // The database is likely the reason the run failed at all. Log and let the
      // original error propagate — replacing it with this one would hide the cause.
      logger?.warn("Reconciler: could not record the failed run", {
        runId: run.runId,
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
    }
    throw err;
  } finally {
    await releaseReconcileLock(db);
  }
}

interface PendingRefundResults {
  readonly polled: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
}

async function pollPendingRefunds(
  deps: ReconcileV15Deps,
  opts: ReconcileV15Options,
): Promise<PendingRefundResults> {
  const { db, registry, logger } = deps;
  const staleAfterMs = opts.pendingRefundStaleAfterMs ?? DEFAULT_PENDING_STALE_MS;
  const staleAfter = new Date(Date.now() - staleAfterMs);

  const pollable = await pendingRefundRepo.listPollable(db, { limit: 100, staleAfter });
  let polled = 0;
  let completed = 0;
  let failed = 0;
  let timedOut = 0;

  for (const row of pollable) {
    polled++;
    await pendingRefundRepo.recordPollAttempt(db, row.pendingId);

    // 24h window check — mark timed_out
    if (Date.now() - row.createdAt.getTime() > PENDING_REFUND_TIMEOUT_MS) {
      await pendingRefundRepo.markTimedOut(db, row.pendingId);
      timedOut++;
      continue;
    }

    const adapter = registry.get(row.provider);
    if (!adapter) {
      logger?.warn(`pollPendingRefunds: no adapter for provider '${row.provider}'`);
      continue;
    }

    // V1.5 V0 polling pattern: each adapter handles its own status query.
    // ZaloPay would have a queryRefund method — V1.5 uses adapter.refund() with same
    // idempotencyKey, which provider treats as status check.
    try {
      const result = await adapter.refund({
        transactionId: row.transactionId,
        amountMicros: BigInt(row.amountMicros.split(".")[0] ?? "0"),
        idempotencyKey: row.idempotencyKey,
        reason: row.reason,
      });
      if (result.state === "completed") {
        // The path that commits the refund ledger entry must also release the
        // reservation, in the same transaction, so remaining is never double-counted.
        // pending_refunds lacks tenantId/ownerId — load from payment_transactions.
        await db.transaction(async (tx) => {
          const [txRow] = await tx
            .select()
            .from(paymentTransactions)
            .where(eq(paymentTransactions.transactionId, row.transactionId))
            .for("update")
            .limit(1);
          if (!txRow) {
            // Orphaned reservation — mark completed to stop polling
            await pendingRefundRepo.markCompleted(tx, row.pendingId);
            return;
          }

          const amountMicros = BigInt(row.amountMicros.split(".")[0] ?? "0");
          const sourceId = `tx:${row.transactionId}:${row.idempotencyKey}`;

          const { inserted } = await ledgerRepo.appendLedgerEntryIdempotent(tx, {
            tenantId: txRow.tenantId,
            ownerId: txRow.ownerId,
            entryType: "refund",
            amountMicros: (-amountMicros).toString(),
            currencyCode: row.currencyCode,
            provider: row.provider,
            sourceId,
            metadataJson: {
              source: "reconciler_refund",
              originalTransactionId: row.transactionId,
              idempotencyKey: row.idempotencyKey,
              providerRefundId: result.providerRefundId ?? null,
            },
          });

          if (inserted) {
            await balanceRepo.applyDelta(tx, txRow.tenantId, row.currencyCode, -amountMicros);

            // Check if cumulative refunds now cover the full original amount
            const totalRefundedStr = await ledgerRepo.sumRefundsByOriginalTransaction(tx, {
              tenantId: txRow.tenantId,
              currencyCode: row.currencyCode,
              originalTransactionId: row.transactionId,
            });
            const totalRefunded = BigInt(totalRefundedStr.split(".")[0] ?? "0"); // negative
            const originalMicros = BigInt(txRow.amountMicros.split(".")[0] ?? "0");
            if (-totalRefunded >= originalMicros) {
              await tx
                .update(paymentTransactions)
                .set({ status: "refunded", updatedAt: new Date() })
                .where(eq(paymentTransactions.transactionId, row.transactionId));
            }
          }

          await pendingRefundRepo.markCompleted(tx, row.pendingId);
        });
        completed++;
      } else if (result.state === "failed" || result.state === "unsupported") {
        await pendingRefundRepo.markFailed(db, row.pendingId, {
          error: result.error?.message ?? "unknown",
          providerCode: result.error?.providerCode ?? null,
        });
        failed++;
      }
      // 'pending' → leave row, will retry next reconcile
    } catch (err) {
      logger?.warn(`pollPendingRefunds: adapter ${row.provider} threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { polled, completed, failed, timedOut };
}
