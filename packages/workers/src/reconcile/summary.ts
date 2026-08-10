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
  /**
   * The two sides agree on the reference but not on the unit of account — e.g. a
   * row stored in USD against a provider record reported in a crypto
   * denomination. Its own type because the numbers are not comparable at all:
   * calling it `amount_mismatch` reports a settlement drift that may not exist
   * and implies a magnitude nobody can act on, when what actually needs fixing
   * is the adapter's normalization.
   */
  | "currency_mismatch"
  | "refund_drift"; // provider shows refund, paykit ledger has no refund entry

export interface Discrepancy {
  readonly type: DiscrepancyType;
  readonly provider: string;
  readonly transactionId: string | null;
  readonly providerRef: string | null;
  readonly paykitAmountMicros: string | null;
  readonly providerAmountMicros: string | null;
  /**
   * Set on `currency_mismatch`, where the two amounts above are in different
   * units and the pair of codes is the whole finding. Omitted elsewhere, since
   * every other type compares like with like.
   */
  readonly paykitCurrencyCode?: string;
  readonly providerCurrencyCode?: string;
  readonly note?: string;
}

export interface PerProviderStats {
  readonly matched: number;
  readonly paykitMissing: number;
  readonly providerMissing: number;
  readonly amountMismatch: number;
  /** Same reference, different unit of account — amounts were never compared. */
  readonly currencyMismatch: number;
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
  currencyMismatch: 0,
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
