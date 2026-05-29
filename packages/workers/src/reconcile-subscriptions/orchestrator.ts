/**
 * V2 reconciler orchestrator (Phase 07).
 *
 * Sequence under advisory lock:
 *   Pass A — cache drift (per tenant/customer)
 *   Pass B — ledger reconciliation (per tenant/customer; read-only)
 *   Pass C — idempotency-records TTL sweep
 *   Canary auto-flip — webhook_strict_v2 runtime_config TTL check (Val S4 Q3)
 *
 * Lock failure → status='skipped_lock_held'.
 * Pass A transient abort on a tenant → status='partial' but other tenants
 * still complete. Pass B always runs (read-only, never mutates).
 */
import { type DbClient, runtimeConfigRepo } from "@vibecc/paykit-server";
import { releaseReconcileLock, tryAcquireReconcileLock } from "../reconcile/advisory-lock.js";
import {
  type CachePassOutcome,
  type CacheRepoPort,
  type StripeAdapterPort,
  runCachePassForCustomer,
} from "./cache-differ.js";
import { sweepIdempotencyExpired } from "./idempotency-sweeper.js";
import {
  type LedgerPassOutcome,
  type PaykitLedgerPort,
  type StripeFinancePort,
  runLedgerPassForTenant,
} from "./ledger-reconciler.js";
import type {
  CacheDiscrepancy,
  CachePassStats,
  IdempotencySweepStats,
  LedgerDrift,
  LedgerPassStats,
  QuarantineEntry,
  V2ReconcilerSummary,
} from "./types.js";

export const CANARY_KEY = "webhook_strict_v2";

export interface ReconcilerTenantTarget {
  readonly tenantId: string;
  readonly customerId: string;
}

export interface ReconcileV2Deps {
  readonly db: DbClient;
  readonly providerId: string;
  readonly cache: CacheRepoPort;
  readonly adapter: StripeAdapterPort;
  readonly stripeFinance: StripeFinancePort;
  readonly ledger: PaykitLedgerPort;
  readonly tenants: readonly ReconcilerTenantTarget[];
  readonly window: { since: Date; until: Date };
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly now?: () => Date;
}

export async function reconcileSubscriptionsV2(
  deps: ReconcileV2Deps,
): Promise<V2ReconcilerSummary> {
  const startedAt = (deps.now ?? (() => new Date()))();
  const acquired = await tryAcquireReconcileLock(deps.db);
  if (!acquired) {
    return finalize(startedAt, "skipped_lock_held", {
      cache: emptyCache(),
      ledger: emptyLedger(),
      idempotencySweep: { deletedCount: 0 },
      quarantine: [],
    });
  }

  const cacheStats: CachePassStats = {
    tenantsScanned: 0,
    discrepancies: [],
    cacheUpdatedCount: 0,
    cacheInsertedCount: 0,
    cacheCanceledCount: 0,
    skippedRecentEvent: 0,
  };
  const ledgerStats: LedgerPassStats = { tenantsScanned: 0, drifts:[]};
  const quarantine: QuarantineEntry[] = [];
  let status: V2ReconcilerSummary["status"] = "completed";

  try {
    for (const target of deps.tenants) {
      const passA = await runCachePassForCustomer({
        tenantId: target.tenantId,
        customerId: target.customerId,
        cache: deps.cache,
        adapter: deps.adapter,
        ...(deps.now !== undefined ? { now: deps.now() } : {}),
      });
      mergeCacheStats(cacheStats, passA);
      quarantine.push(...passA.quarantine);
      if (passA.transientAbort) status = "partial";

      const passB = await runLedgerPassForTenant({
        tenantId: target.tenantId,
        customerId: target.customerId,
        providerId: deps.providerId,
        window: deps.window,
        stripe: deps.stripeFinance,
        ledger: deps.ledger,
      });
      mergeLedgerStats(ledgerStats, passB);
      quarantine.push(...passB.quarantine);
    }

    const sweep = await sweepIdempotencyExpired(deps.db, (deps.now ?? (() => new Date()))());
    await maybeFlipCanary(deps);

    return finalize(startedAt, status, {
      cache: cacheStats,
      ledger: ledgerStats,
      idempotencySweep: sweep,
      quarantine,
    });
  } catch (err) {
    deps.logger?.warn("reconciler_failed", { error: errMsg(err) });
    return finalize(startedAt, "failed", {
      cache: cacheStats,
      ledger: ledgerStats,
      idempotencySweep: { deletedCount: 0 },
      quarantine,
    });
  } finally {
    await releaseReconcileLock(deps.db);
  }
}

function mergeCacheStats(stats: CachePassStats, outcome: CachePassOutcome): void {
  (stats as { tenantsScanned: number }).tenantsScanned += 1;
  (stats.discrepancies as CacheDiscrepancy[]).push(...outcome.discrepancies);
  (stats as { cacheInsertedCount: number }).cacheInsertedCount += outcome.inserted;
  (stats as { cacheUpdatedCount: number }).cacheUpdatedCount += outcome.updated;
  (stats as { cacheCanceledCount: number }).cacheCanceledCount += outcome.canceled;
  (stats as { skippedRecentEvent: number }).skippedRecentEvent += outcome.skippedRecentEvent;
}

function mergeLedgerStats(stats: LedgerPassStats, outcome: LedgerPassOutcome): void {
  (stats as { tenantsScanned: number }).tenantsScanned += 1;
  (stats.drifts as LedgerDrift[]).push(...outcome.drifts);
}

function emptyCache(): CachePassStats {
  return {
    tenantsScanned: 0,
    discrepancies: [],
    cacheUpdatedCount: 0,
    cacheInsertedCount: 0,
    cacheCanceledCount: 0,
    skippedRecentEvent: 0,
  };
}

function emptyLedger(): LedgerPassStats {
  return { tenantsScanned: 0, drifts: [] };
}

async function maybeFlipCanary(deps: ReconcileV2Deps): Promise<void> {
  const row = await runtimeConfigRepo.getKey(deps.db, CANARY_KEY);
  if (!row) return;
  if (row.expiresAt === null) return;
  const now = (deps.now ?? (() => new Date()))();
  if (row.expiresAt.getTime() <= now.getTime() && row.value !== "true") {
    await runtimeConfigRepo.setKey(deps.db, {
      key: CANARY_KEY,
      value: "true",
      expiresAt: null,
    });
    deps.logger?.warn("canary_auto_flipped", { key: CANARY_KEY, at: now.toISOString() });
  }
}

function finalize(
  startedAt: Date,
  status: V2ReconcilerSummary["status"],
  parts: Pick<V2ReconcilerSummary, "cache" | "ledger" | "idempotencySweep" | "quarantine">,
): V2ReconcilerSummary {
  return {
    cache: parts.cache,
    ledger: parts.ledger,
    idempotencySweep: parts.idempotencySweep,
    quarantine: parts.quarantine,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    status,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface IdempotencySweepStatsHelper extends IdempotencySweepStats {}
void undefined as unknown as IdempotencySweepStatsHelper;
