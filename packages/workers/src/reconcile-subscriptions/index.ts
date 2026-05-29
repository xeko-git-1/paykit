/**
 * V2 reconcile-subscriptions barrel.
 *
 * Phase 07 entry points:
 *   - reconcileSubscriptionsV2: orchestrator (Pass A → Pass B → Pass C → canary)
 *   - runCachePassForCustomer: Pass A primitive (testable)
 *   - runLedgerPassForTenant: Pass B primitive (testable)
 *   - sweepIdempotencyExpired: Pass C
 *   - evaluateDriftGate: drift-gate primitive (RT F2, F9)
 */
export { evaluateDriftGate, type DriftGateAdapter, type DriftGateOutcome } from "./drift-gate.js";
export {
  runCachePassForCustomer,
  type CachePassOutcome,
  type CacheRepoPort,
  type CacheRow,
  type StripeAdapterPort,
} from "./cache-differ.js";
export {
  runLedgerPassForTenant,
  type LedgerPassOutcome,
  type PaykitLedgerPort,
  type PaykitLedgerWindow,
  type StripeFinancePort,
  type StripeFinanceWindow,
} from "./ledger-reconciler.js";
export { sweepIdempotencyExpired, type SweepIdempotencyResult } from "./idempotency-sweeper.js";
export {
  CANARY_KEY,
  reconcileSubscriptionsV2,
  type ReconcileV2Deps,
  type ReconcilerTenantTarget,
} from "./orchestrator.js";
export type {
  CacheDiscrepancy,
  CacheDiscrepancyType,
  CachePassStats,
  IdempotencySweepStats,
  LedgerDrift,
  LedgerPassStats,
  QuarantineEntry,
  V2ReconcilerSummary,
} from "./types.js";
