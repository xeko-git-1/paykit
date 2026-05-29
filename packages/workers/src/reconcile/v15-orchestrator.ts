/**
 * V1.5 reconcile orchestrator — registry-based.
 *
 * Iterates over all adapters in the ProviderRegistry; for each, calls
 * `adapter.fetchTransactions(window)` and diffs against paykit's snapshot.
 *
 * 3-level run status (red-team F10):
 *   - 'completed': all adapters succeeded
 *   - 'partial':   some adapters threw or timed out; others succeeded
 *   - 'failed':    fatal error (lock acquisition, DB issue)
 *
 * Pending refunds (ZaloPay PROCESSING) polled in same run via `pollPendingRefunds`.
 */
import type { ProviderRegistry } from "@vibecc/paykit";
import {
  type DbClient,
  type PaymentTransaction,
  paymentTransactions,
  pendingRefundRepo,
  reconciliationRepo,
} from "@vibecc/paykit-server";
import { and, gte, lt } from "drizzle-orm";
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
  readonly status: "completed" | "partial" | "failed";
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
    return { summary: null, skipped: "lock_held", status: "failed" };
  }

  try {
    const startedAt = new Date();
    const run = await reconciliationRepo.startRun(db, startedAt);

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

    // Compute final run status
    const hasFailures = Object.keys(adapterErrors).length > 0;
    const runStatus: "completed" | "partial" =
      hasFailures || pendingResults.failed > 0 ? "partial" : "completed";

    const summary: ReconciliationSummary = {
      runId: run.runId,
      startedAt,
      completedAt: new Date(),
      status: "completed",
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

    await reconciliationRepo.completeRun(
      db,
      run.runId,
      runStatus === "partial" ? "failed" : "completed",
      summaryJson,
    );

    return { summary, skipped: false, status: runStatus };
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
        await pendingRefundRepo.markCompleted(db, row.pendingId);
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
