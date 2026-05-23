// @vibecc/paykit-workers — reconciliation engine. Designed to be invoked
// from a cron / BullMQ / Cloudflare Cron — not a long-running daemon.

export {
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

export const PAYKIT_WORKERS_VERSION = "0.1.5-alpha.1";
