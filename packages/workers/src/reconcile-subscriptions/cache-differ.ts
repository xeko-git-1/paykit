/**
 * Pass A — paykit-vs-Stripe diff + cache mutator (RT 15c, F14).
 *
 * Inputs are abstracted as ports so tests can drive everything without a
 * real Postgres + Stripe SDK. The orchestrator wires the real adapter +
 * subscription.repo when running in production.
 */
import type { SubscriptionResult, SubscriptionStatus } from "@vibecc/paykit";
import type { CacheDiscrepancy, QuarantineEntry } from "./types.js";
import { evaluateDriftGate, type DriftGateAdapter } from "./drift-gate.js";

export interface CacheRow {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly providerSubscriptionId: string;
  readonly customerId: string;
  readonly priceId: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly currencyCode: string;
  readonly latestInvoiceId: string | null;
  readonly lastEventCreated: Date;
}

export interface CacheRepoPort {
  listForTenantActive(tenantId: string): Promise<readonly CacheRow[]>;
  upsert(input: {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly providerSubscriptionId: string;
    readonly customerId: string;
    readonly priceId: string;
    readonly status: SubscriptionStatus;
    readonly currencyCode: string;
    readonly currentPeriodEnd: Date;
    readonly cancelAtPeriodEnd: boolean;
    readonly latestInvoiceId?: string;
    readonly lastEventCreated: Date;
  }): Promise<void>;
  markCanceled(providerSubscriptionId: string, lastEventCreated: Date): Promise<void>;
}

export interface StripeAdapterPort extends DriftGateAdapter {
  listForCustomer(customerId: string): Promise<readonly SubscriptionResult[]>;
  retrieve(subscriptionId: string): Promise<SubscriptionResult | null>;
}

export interface RunCachePassInput {
  readonly tenantId: string;
  readonly customerId: string;
  readonly cache: CacheRepoPort;
  readonly adapter: StripeAdapterPort;
  readonly now?: Date;
}

export interface CachePassOutcome {
  discrepancies: CacheDiscrepancy[];
  quarantine: QuarantineEntry[];
  inserted: number;
  updated: number;
  canceled: number;
  skippedRecentEvent: number;
  transientAbort: boolean;
}

export async function runCachePassForCustomer(
  input: RunCachePassInput,
): Promise<CachePassOutcome> {
  const out: CachePassOutcome = {
    discrepancies: [],
    quarantine: [],
    inserted: 0,
    updated: 0,
    canceled: 0,
    skippedRecentEvent: 0,
    transientAbort: false,
  };

  let stripeSubs: readonly SubscriptionResult[];
  try {
    stripeSubs = await input.adapter.listForCustomer(input.customerId);
  } catch (err) {
    out.transientAbort = true;
    out.quarantine.push({
      reason: "stripe_transient_5xx",
      tenantId: input.tenantId,
      details: { customerId: input.customerId, error: errMsg(err) },
    });
    return out;
  }

  const cacheRows = await input.cache.listForTenantActive(input.tenantId);
  const stripeById = new Map(stripeSubs.map((s) => [s.id, s]));
  const cacheById = new Map(cacheRows.map((r) => [r.providerSubscriptionId, r]));

  // paykit_missing: Stripe has, paykit doesn't
  for (const s of stripeSubs) {
    if (cacheById.has(s.id)) continue;
    out.discrepancies.push({
      type: "paykit_missing",
      providerSubscriptionId: s.id,
      tenantId: input.tenantId,
      stripeField: { status: s.status, priceId: s.priceId },
    });
    await input.cache.upsert({
      tenantId: input.tenantId,
      ownerId: input.tenantId,
      providerSubscriptionId: s.id,
      customerId: s.customerId,
      priceId: s.priceId,
      status: s.status,
      currencyCode: s.currencyCode,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      lastEventCreated: s.lastEventCreated,
      ...(s.latestInvoiceId !== undefined ? { latestInvoiceId: s.latestInvoiceId } : {}),
    });
    out.inserted++;
  }

  // provider_missing + field_drift: scan paykit-side
  for (const r of cacheRows) {
    const stripe = stripeById.get(r.providerSubscriptionId);

    if (!stripe) {
      // List didn't include it. RT F14: require POSITIVE proof.
      const remote = await input.adapter.retrieve(r.providerSubscriptionId);
      if (remote) continue; // late list inconsistency; ignore
      out.discrepancies.push({
        type: "provider_missing",
        providerSubscriptionId: r.providerSubscriptionId,
        tenantId: input.tenantId,
        paykitField: { status: r.status },
      });
      // Quarantine instead of auto-cancel UNLESS retrieve confirms 404 with
      // an explicit absence signal. retrieve returning null IS the proof.
      out.quarantine.push({
        reason: "list_only_provider_missing",
        tenantId: input.tenantId,
        subscriptionId: r.providerSubscriptionId,
        details: { paykitStatus: r.status },
      });
      // Mark canceled because retrieve confirms absence (positive proof).
      await input.cache.markCanceled(
        r.providerSubscriptionId,
        input.now ?? new Date(),
      );
      out.canceled++;
      continue;
    }

    const drift = await detectFieldDrift(r, stripe);
    if (drift.length === 0) continue;

    const gate = await evaluateDriftGate(input.adapter, {
      subscriptionId: r.providerSubscriptionId,
      cacheLastEventCreated: r.lastEventCreated,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (!gate.allow) {
      if (gate.reason === "fresh_skip") {
        out.skippedRecentEvent++;
        out.quarantine.push({
          reason: "drift_gate_recent_event",
          tenantId: input.tenantId,
          subscriptionId: r.providerSubscriptionId,
          details: { fields: drift },
        });
      }
      continue;
    }

    out.discrepancies.push({
      type: "field_drift",
      providerSubscriptionId: r.providerSubscriptionId,
      tenantId: input.tenantId,
      paykitField: { status: r.status },
      stripeField: { status: stripe.status, fields: drift },
    });
    await input.cache.upsert({
      tenantId: r.tenantId,
      ownerId: r.ownerId,
      providerSubscriptionId: r.providerSubscriptionId,
      customerId: stripe.customerId,
      priceId: stripe.priceId,
      status: stripe.status,
      currencyCode: stripe.currencyCode,
      currentPeriodEnd: stripe.currentPeriodEnd,
      cancelAtPeriodEnd: stripe.cancelAtPeriodEnd,
      lastEventCreated: stripe.lastEventCreated,
      ...(stripe.latestInvoiceId !== undefined ? { latestInvoiceId: stripe.latestInvoiceId } : {}),
    });
    out.updated++;
  }

  return out;
}

async function detectFieldDrift(
  cache: CacheRow,
  stripe: SubscriptionResult,
): Promise<string[]> {
  const drift: string[] =[];
  if (cache.status !== stripe.status) drift.push("status");
  if (cache.currentPeriodEnd.getTime() !== stripe.currentPeriodEnd.getTime()) {
    drift.push("currentPeriodEnd");
  }
  if (cache.cancelAtPeriodEnd !== stripe.cancelAtPeriodEnd) drift.push("cancelAtPeriodEnd");
  if (cache.priceId !== stripe.priceId) drift.push("priceId");
  return drift;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
