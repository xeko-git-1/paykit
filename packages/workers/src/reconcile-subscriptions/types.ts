/**
 * V2 reconciler types — shared across orchestrator + Pass A/B + tests.
 *
 * Pass A discrepancy types are simplified to 3 buckets per RT 15c:
 *   - paykit_missing : Stripe has, paykit doesn't → INSERT cache row
 *   - provider_missing: paykit has, retrieve returns 404 → mark canceled
 *                       (RT F14: requires POSITIVE proof; list-only evidence
 *                       routes to quarantine instead)
 *   - field_drift   : paykit has, Stripe has, fields differ (status / period
 *                     / cancelAtPeriodEnd / customer)
 */
export type CacheDiscrepancyType = "paykit_missing" | "provider_missing" | "field_drift";

export interface CacheDiscrepancy {
  readonly type: CacheDiscrepancyType;
  readonly providerSubscriptionId: string;
  readonly tenantId: string;
  readonly paykitField?: Record<string, unknown>;
  readonly stripeField?: Record<string, unknown>;
}

export interface QuarantineEntry {
  readonly reason:
    | "list_only_provider_missing"
    | "stripe_transient_5xx"
    | "ledger_drift"
    | "drift_gate_recent_event";
  readonly subscriptionId?: string;
  readonly tenantId: string;
  readonly details: Record<string, unknown>;
}

export interface CachePassStats {
  readonly tenantsScanned: number;
  readonly discrepancies: readonly CacheDiscrepancy[];
  readonly cacheUpdatedCount: number;
  readonly cacheInsertedCount: number;
  readonly cacheCanceledCount: number;
  readonly skippedRecentEvent: number;
}

export interface LedgerPassStats {
  readonly tenantsScanned: number;
  readonly drifts: readonly LedgerDrift[];
}

export interface LedgerDrift {
  readonly tenantId: string;
  readonly expectedNetMicros: string;
  readonly actualLedgerMicros: string;
  readonly deltaMicros: string;
}

export interface IdempotencySweepStats {
  readonly deletedCount: number;
}

export interface V2ReconcilerSummary {
  readonly cache: CachePassStats;
  readonly ledger: LedgerPassStats;
  readonly idempotencySweep: IdempotencySweepStats;
  readonly quarantine: readonly QuarantineEntry[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "completed" | "partial" | "failed" | "skipped_lock_held";
}
