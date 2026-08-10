import {
  type DbClient,
  type PaymentTransaction,
  paymentTransactions,
  reconciliationRepo,
} from "@xeko-git-1/paykit-server";
/**
 * Reconciliation orchestrator — main entry point.
 *
 * Flow:
 *   1. Acquire advisory lock; if held, return early (concurrent-safe).
 *   2. Insert reconciliation_runs row (status=running).
 *   3. Snapshot paykit payment_transactions in window.
 *   4. Fetch provider records (Stripe + SePay) for window.
 *   5. Diff per-provider → discrepancies.
 *   6. Update reconciliation_runs (status=completed, summary_json).
 *   7. Release lock.
 *
 * Idempotent: re-running same window appends a new run row, computes the same
 * classification.
 */
import { and, gte, lt } from "drizzle-orm";
import { releaseReconcileLock, tryAcquireReconcileLock } from "./advisory-lock.js";
import { type PaykitTxnSnapshot, diffPaykitVsProvider } from "./differ.js";
import type { SepayFetcher } from "./sepay-fetcher.js";
import type { StripeFetcher } from "./stripe-fetcher.js";
import { EMPTY_PER_PROVIDER, type ReconciliationSummary, summaryToJson } from "./summary.js";

export interface ReconcileOptions {
  readonly since: Date;
  readonly until?: Date;
  readonly providers?: readonly ("stripe" | "sepay")[];
}

export interface ReconcileDeps {
  readonly db: DbClient;
  readonly stripeFetcher: StripeFetcher;
  readonly sepayFetcher: SepayFetcher;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export interface ReconcileResult {
  readonly summary: ReconciliationSummary | null;
  readonly skipped: false | "lock_held";
}

export async function reconcile(
  deps: ReconcileDeps,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const { db, stripeFetcher, sepayFetcher } = deps;
  const since = opts.since;
  const until = opts.until ?? new Date();
  const providers = new Set(opts.providers ?? (["stripe", "sepay"] as const));

  const acquired = await tryAcquireReconcileLock(db);
  if (!acquired) {
    return { summary: null, skipped: "lock_held" };
  }

  try {
    const startedAt = new Date();
    const run = await reconciliationRepo.startRun(db, startedAt);

    // Snapshot paykit transactions in window.
    const paykitRows = await db
      .select()
      .from(paymentTransactions)
      .where(
        and(gte(paymentTransactions.createdAt, since), lt(paymentTransactions.createdAt, until)),
      );

    const stripeSnapshot: PaykitTxnSnapshot[] = paykitRows
      .filter((r: PaymentTransaction) => r.provider === "stripe")
      .map((r: PaymentTransaction) => ({
        transactionId: r.transactionId,
        providerRef: r.providerRef,
        amountMicros: r.amountMicros,
        currencyCode: r.currencyCode,
        status: r.status,
      }));
    const sepaySnapshot: PaykitTxnSnapshot[] = paykitRows
      .filter((r: PaymentTransaction) => r.provider === "sepay")
      .map((r: PaymentTransaction) => ({
        transactionId: r.transactionId,
        providerRef: r.providerRef,
        amountMicros: r.amountMicros,
        currencyCode: r.currencyCode,
        status: r.status,
      }));

    let stripeStats = EMPTY_PER_PROVIDER;
    let sepayStats = EMPTY_PER_PROVIDER;
    const allDiscrepancies = [];

    if (providers.has("stripe")) {
      const records = await stripeFetcher.list({ since, until });
      const result = diffPaykitVsProvider("stripe", stripeSnapshot, records);
      stripeStats = result.stats;
      allDiscrepancies.push(...result.discrepancies);
    }

    if (providers.has("sepay")) {
      const records = await sepayFetcher.list({ since, until });
      const result = diffPaykitVsProvider("sepay", sepaySnapshot, records);
      sepayStats = result.stats;
      allDiscrepancies.push(...result.discrepancies);
    }

    const summary: ReconciliationSummary = {
      runId: run.runId,
      startedAt,
      completedAt: new Date(),
      status: "completed",
      window: { since, until },
      perProvider: { stripe: stripeStats, sepay: sepayStats },
      discrepancies: allDiscrepancies,
    };

    await reconciliationRepo.completeRun(db, run.runId, "completed", summaryToJson(summary));
    return { summary, skipped: false };
  } finally {
    await releaseReconcileLock(db);
  }
}
