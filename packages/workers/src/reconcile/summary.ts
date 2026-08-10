/**
 * Reconciliation summary types — JSONB-serializable shape stored in
 * paykit.reconciliation_runs.summary_json.
 *
 * BigInt is converted to MicrosString at serialization boundary; never leak
 * BigInt to JSON.
 */

import type { ReconciliationRunStatus } from "@xeko-git-1/paykit-server";

export type DiscrepancyType =
  | "matched"
  | "paykit_missing" // provider has tx, paykit doesn't
  | "provider_missing" // paykit has tx, provider doesn't
  | "amount_mismatch"
  | "refund_drift"; // provider shows refund, paykit ledger has no refund entry

export interface Discrepancy {
  readonly type: DiscrepancyType;
  readonly provider: string;
  readonly transactionId: string | null;
  readonly providerRef: string | null;
  readonly paykitAmountMicros: string | null;
  readonly providerAmountMicros: string | null;
  readonly note?: string;
}

export interface PerProviderStats {
  readonly matched: number;
  readonly paykitMissing: number;
  readonly providerMissing: number;
  readonly amountMismatch: number;
  readonly refundDrift: number;
}

export interface ReconciliationSummary {
  readonly runId: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  /**
   * Reuses the run-status vocabulary from the reconciliation_runs table, so the
   * summary written into `summary_json` cannot describe an outcome the row itself
   * is unable to hold. `partial` and `skipped` matter here for the same reason
   * they matter on the row: a run that lost one provider out of four still
   * reconciled four, and a run that found the lock held did no work at all.
   */
  readonly status: ReconciliationRunStatus;
  readonly window: { readonly since: Date; readonly until: Date };
  readonly perProvider: Record<string, PerProviderStats>;
  readonly discrepancies: readonly Discrepancy[];
}

export const EMPTY_PER_PROVIDER: PerProviderStats = {
  matched: 0,
  paykitMissing: 0,
  providerMissing: 0,
  amountMismatch: 0,
  refundDrift: 0,
};

export function summaryToJson(summary: ReconciliationSummary): Record<string, unknown> {
  return {
    runId: summary.runId,
    startedAt: summary.startedAt.toISOString(),
    completedAt: summary.completedAt?.toISOString() ?? null,
    status: summary.status,
    window: {
      since: summary.window.since.toISOString(),
      until: summary.window.until.toISOString(),
    },
    perProvider: summary.perProvider,
    discrepancies: summary.discrepancies.slice(0, 1000), // cap detail at 1000
    discrepancyTotal: summary.discrepancies.length,
  };
}
