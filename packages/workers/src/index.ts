// @xeko-git-1/paykit-workers — reconciliation engine. Designed to be invoked
// from a cron / BullMQ / Cloudflare Cron — not a long-running daemon.

export {
  acquireReconcileLock,
  holdsReconcileLock,
  type ReconcileLockLease,
  releaseReconcileLock,
  tryAcquireReconcileLock,
  RECONCILE_LOCK_NAME,
} from "./reconcile/advisory-lock.js";
export type {
  Discrepancy,
  DiscrepancyType,
  PerProviderStats,
  ReconciliationSummary,
} from "./reconcile/summary.js";
export {
  EMPTY_PER_PROVIDER,
  summaryToJson,
} from "./reconcile/summary.js";
export {
  diffPaykitVsProvider,
  type PaykitTxnSnapshot,
  type ProviderTxnRecord,
} from "./reconcile/differ.js";
export {
  createStripeFetcher,
  type StripeFetcher,
} from "./reconcile/stripe-fetcher.js";
export {
  createSepayFetcher,
  type SepayApiTxn,
  type SepayFetcher,
} from "./reconcile/sepay-fetcher.js";
export {
  reconcile,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileResult,
} from "./reconcile/orchestrator.js";
export {
  reconcileV15,
  type ReconcileV15Deps,
  type ReconcileV15Options,
  type ReconcileV15Result,
} from "./reconcile/v15-orchestrator.js";

// V2 subscription reconciler (Phase 07)
export {
  CANARY_KEY,
  evaluateDriftGate,
  reconcileSubscriptionsV2,
  runCachePassForCustomer,
  runLedgerPassForTenant,
  sweepIdempotencyExpired,
  type CacheDiscrepancy,
  type CacheDiscrepancyType,
  type CachePassOutcome,
  type CachePassStats,
  type CacheRepoPort,
  type CacheRow,
  type DriftGateAdapter,
  type DriftGateOutcome,
  type IdempotencySweepStats,
  type LedgerDrift,
  type LedgerPassOutcome,
  type LedgerPassStats,
  type PaykitLedgerPort,
  type PaykitLedgerWindow,
  type QuarantineEntry,
  type ReconcileV2Deps,
  type ReconcilerTenantTarget,
  type StripeAdapterPort,
  type StripeFinancePort,
  type StripeFinanceWindow,
  type SweepIdempotencyResult,
  type V2ReconcilerSummary,
} from "./reconcile-subscriptions/index.js";

// V2 customer backfill (Phase 09, RT F13)
export {
  backfillCustomers,
  type BackfillCustomersInput,
  type BackfillCustomersResult,
} from "./backfill/backfill-customers.js";

export const PAYKIT_WORKERS_VERSION = "0.2.0-alpha.1";
