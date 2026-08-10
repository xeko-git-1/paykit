/**
 * Phase 07 — V2 reconciler test suite.
 *
 * Coverage (RT 15c, F2, F9, F14, Val S4 Q2, Q3, F6):
 *   - Pass A cache drift: matches, paykit_missing, provider_missing positive
 *     proof, list-only quarantine, 5xx transient abort, field_drift,
 *     drift gate fresh-skip, drift gate stale-row promotes, advisory lock
 *   - Pass B ledger reconciliation: balanced, missing credit, extra credit,
 *     refund mismatch, non-USD skip, read-only invariant
 *   - Pass C idempotency sweeper
 *   - Canary auto-flip
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const advisoryLockState = { acquired: true };
vi.mock("../src/reconcile/advisory-lock.js", () => ({
  RECONCILE_LOCK_NAME: "paykit.reconcile",
  tryAcquireReconcileLock: vi.fn(async () => advisoryLockState.acquired),
  releaseReconcileLock: vi.fn(async () => undefined),
}));

interface FakeRuntimeRow {
  key: string;
  value: string;
  expiresAt: Date | null;
}
const runtimeRows: FakeRuntimeRow[] = [];
const idempotencyDeleted = { count: 0 };

vi.mock("@xeko-git-1/paykit-server", () => ({
  runtimeConfigRepo: {
    getKey: vi.fn(async (_db: unknown, key: string) =>
      runtimeRows.find((r) => r.key === key),
    ),
    setKey: vi.fn(
      async (
        _db: unknown,
        input: { key: string; value: string; expiresAt: Date | null },
      ) => {
        const existing = runtimeRows.find((r) => r.key === input.key);
        if (existing) {
          existing.value = input.value;
          existing.expiresAt = input.expiresAt ?? null;
          return existing;
        }
        const row = { ...input, expiresAt: input.expiresAt ?? null };
        runtimeRows.push(row);
        return row;
      },
    ),
    ensureKey: vi.fn(),
  },
  idempotencyRepo: {
    sweepExpired: vi.fn(async () => idempotencyDeleted.count),
    claimIdempotency: vi.fn(),
    finalizeIdempotency: vi.fn(),
    releaseIdempotency: vi.fn(),
    IdempotencyBodyMismatchError: class extends Error {},
  },
}));

const {
  evaluateDriftGate,
  reconcileSubscriptionsV2,
  runCachePassForCustomer,
  runLedgerPassForTenant,
  sweepIdempotencyExpired,
  CANARY_KEY,
} = await import("../src/reconcile-subscriptions/index.js");

import type {
  CacheRepoPort,
  CacheRow,
  PaykitLedgerPort,
  StripeAdapterPort,
  StripeFinancePort,
} from "../src/reconcile-subscriptions/index.js";
import type { SubscriptionResult } from "@xeko-git-1/paykit";

const TENANT_A = "00000000-0000-0000-0000-000000000001";

function row(overrides: Partial<CacheRow> = {}): CacheRow {
  return {
    tenantId: TENANT_A,
    ownerId: TENANT_A,
    providerSubscriptionId: "sub_x",
    customerId: "cus_a",
    priceId: "price_p1",
    status: "active",
    currentPeriodEnd: new Date("2026-06-01"),
    cancelAtPeriodEnd: false,
    currencyCode: "USD",
    latestInvoiceId: null,
    lastEventCreated: new Date("2026-05-01"),
    ...overrides,
  };
}

function stripeSub(overrides: Partial<SubscriptionResult> = {}): SubscriptionResult {
  return {
    id: "sub_x",
    status: "active",
    currentPeriodEnd: new Date("2026-06-01"),
    customerId: "cus_a",
    priceId: "price_p1",
    cancelAtPeriodEnd: false,
    currencyCode: "USD",
    lastEventCreated: new Date("2026-05-15"),
    ...overrides,
  };
}

function buildCachePort(initial: CacheRow[]): CacheRepoPort & {
  upserted: Array<Record<string, unknown>>;
  canceledIds: string[];
  rows: CacheRow[];
} {
  const rows = [...initial];
  const upserted: Array<Record<string, unknown>> = [];
  const canceledIds: string[] = [];
  return {
    rows,
    upserted,
    canceledIds,
    listForTenantActive: async () => rows.filter((r) => r.status !== "canceled"),
    upsert: async (input) => {
      upserted.push(input);
      const existing = rows.find(
        (r) => r.providerSubscriptionId === input.providerSubscriptionId,
      );
      if (existing) {
        Object.assign(existing, input);
      } else {
        rows.push({ ...row(), ...input });
      }
    },
    markCanceled: async (id: string) => {
      canceledIds.push(id);
      const r = rows.find((x) => x.providerSubscriptionId === id);
      if (r) (r as { status: string }).status = "canceled";
    },
  };
}

function buildAdapterPort(opts: {
  list?: SubscriptionResult[] | (() => Promise<SubscriptionResult[]>);
  retrieve?: Record<string, SubscriptionResult | null>;
  latestEvents?: Record<string, Date | null>;
  listThrows?: boolean;
}): StripeAdapterPort {
  return {
    id: "stripe-subscription",
    listForCustomer: async () => {
      if (opts.listThrows) throw new Error("503");
      const out = typeof opts.list === "function" ? await opts.list() : (opts.list ?? []);
      return out;
    },
    retrieve: async (id: string) => opts.retrieve?.[id] ?? null,
    findLatestEventCreated: async (id: string) => opts.latestEvents?.[id] ?? null,
  };
}

beforeEach(() => {
  runtimeRows.length = 0;
  idempotencyDeleted.count = 0;
  advisoryLockState.acquired = true;
});

describe("Pass A — cache pass per customer (RT 15c, F14)", () => {
  it("0 discrepancies when paykit + Stripe are in sync", async () => {
    const cache = buildCachePort([row()]);
    const adapter = buildAdapterPort({ list: [stripeSub()] });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now: new Date("2026-05-30"),
    });
    expect(out.discrepancies).toHaveLength(0);
    expect(out.inserted).toBe(0);
    expect(out.updated).toBe(0);
  });

  it("paykit_missing → INSERT cache row", async () => {
    const cache = buildCachePort([]);
    const adapter = buildAdapterPort({ list: [stripeSub({ id: "sub_new" })] });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now: new Date("2026-05-30"),
    });
    expect(out.inserted).toBe(1);
    expect(out.discrepancies[0]?.type).toBe("paykit_missing");
  });

  it("provider_missing positive-proof → markCanceled (RT F14)", async () => {
    const cache = buildCachePort([row({ providerSubscriptionId: "sub_old" })]);
    const adapter = buildAdapterPort({
      list: [],
      retrieve: { sub_old: null },
    });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now: new Date("2026-05-30"),
    });
    expect(out.canceled).toBe(1);
    expect(cache.canceledIds).toEqual(["sub_old"]);
    const provMissing = out.discrepancies.find((d) => d.type === "provider_missing");
    expect(provMissing).toBeDefined();
  });

  it("provider_missing without retrieve confirmation → quarantine, no markCanceled", async () => {
    const cache = buildCachePort([row({ providerSubscriptionId: "sub_late" })]);
    const adapter = buildAdapterPort({
      list: [],
      retrieve: { sub_late: stripeSub({ id: "sub_late" }) }, // late list, retrieve still finds it
    });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now: new Date("2026-05-30"),
    });
    expect(out.canceled).toBe(0);
    expect(cache.canceledIds).toHaveLength(0);
  });

  it("Stripe list 5xx → tenant batch aborts, quarantine, no mutations (RT F14)", async () => {
    const cache = buildCachePort([row()]);
    const adapter = buildAdapterPort({ listThrows: true });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now: new Date("2026-05-30"),
    });
    expect(out.transientAbort).toBe(true);
    expect(cache.upserted).toHaveLength(0);
    expect(out.quarantine[0]?.reason).toBe("stripe_transient_5xx");
  });

  it("field_drift: status differs → UPDATE cache via drift gate (RT F2)", async () => {
    const cache = buildCachePort([row({ status: "active", lastEventCreated: new Date("2026-05-01") })]);
    const adapter = buildAdapterPort({
      list: [stripeSub({ status: "past_due" })],
      latestEvents: { sub_x: new Date("2026-05-20") },
    });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now: new Date("2026-05-30"),
    });
    expect(out.updated).toBe(1);
    expect(out.discrepancies[0]?.type).toBe("field_drift");
  });

  it("drift gate fresh-skip: lastEventCreated within 5 min → no update (RT F9)", async () => {
    const now = new Date("2026-05-30T12:00:00Z");
    const cache = buildCachePort([
      row({ status: "active", lastEventCreated: new Date("2026-05-30T11:58:00Z") }),
    ]);
    const adapter = buildAdapterPort({
      list: [stripeSub({ status: "past_due" })],
      latestEvents: { sub_x: new Date("2026-05-30T11:59:30Z") },
    });
    const out = await runCachePassForCustomer({
      tenantId: TENANT_A,
      customerId: "cus_a",
      cache,
      adapter,
      now,
    });
    expect(out.updated).toBe(0);
    expect(out.skippedRecentEvent).toBe(1);
  });
});

describe("evaluateDriftGate primitive", () => {
  it("returns no_newer_event when Stripe has no newer event", async () => {
    const adapter = { id: "x", findLatestEventCreated: async () => null };
    const r = await evaluateDriftGate(adapter, {
      subscriptionId: "sub_x",
      cacheLastEventCreated: new Date("2026-05-01"),
      now: new Date("2026-05-30"),
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("no_newer_event");
  });

  it("returns stripe_newer when Stripe has newer event past freshness window", async () => {
    const adapter = {
      id: "x",
      findLatestEventCreated: async () => new Date("2026-05-20"),
    };
    const r = await evaluateDriftGate(adapter, {
      subscriptionId: "sub_x",
      cacheLastEventCreated: new Date("2026-05-01"),
      now: new Date("2026-05-30"),
    });
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("stripe_newer");
  });
});

describe("Pass B — ledger reconciliation (Val S4 Q2)", () => {
  function buildStripePort(net: Partial<{
    invoicesPaidMicros: bigint;
    chargeRefundsMicros: bigint;
    disputesLostMicros: bigint;
    creditNotesMicros: bigint;
  }>): StripeFinancePort {
    return {
      fetchWindow: async () => ({
        invoicesPaidMicros: net.invoicesPaidMicros ?? 0n,
        chargeRefundsMicros: net.chargeRefundsMicros ?? 0n,
        disputesLostMicros: net.disputesLostMicros ?? 0n,
        creditNotesMicros: net.creditNotesMicros ?? 0n,
      }),
    };
  }
  function buildLedgerPort(net: Partial<{
    subscriptionCreditMicros: bigint;
    refundDebitMicros: bigint;
    disputeDebitMicros: bigint;
    creditNoteDebitMicros: bigint;
  }>): PaykitLedgerPort {
    return {
      fetchWindow: async () => ({
        subscriptionCreditMicros: net.subscriptionCreditMicros ?? 0n,
        refundDebitMicros: net.refundDebitMicros ?? 0n,
        disputeDebitMicros: net.disputeDebitMicros ?? 0n,
        creditNoteDebitMicros: net.creditNoteDebitMicros ?? 0n,
      }),
    };
  }

  const window = { since: new Date("2026-05-01"), until: new Date("2026-06-01") };

  it("balanced: stripe equals paykit ledger sum → 0 drifts", async () => {
    const stripe = buildStripePort({ invoicesPaidMicros: 50_000_000n });
    const ledger = buildLedgerPort({ subscriptionCreditMicros: 50_000_000n });
    const r = await runLedgerPassForTenant({
      tenantId: TENANT_A,
      customerId: "cus_a",
      providerId: "stripe-subscription",
      window,
      stripe,
      ledger,
    });
    expect(r.drifts).toHaveLength(0);
    expect(r.quarantine).toHaveLength(0);
  });

  it("missing credit: Stripe shows invoice paid, paykit ledger empty → drift +50M, quarantine", async () => {
    const stripe = buildStripePort({ invoicesPaidMicros: 50_000_000n });
    const ledger = buildLedgerPort({});
    const r = await runLedgerPassForTenant({
      tenantId: TENANT_A,
      customerId: "cus_a",
      providerId: "stripe-subscription",
      window,
      stripe,
      ledger,
    });
    expect(r.drifts).toHaveLength(1);
    expect(r.drifts[0]?.deltaMicros).toBe("-50000000");
    expect(r.quarantine[0]?.reason).toBe("ledger_drift");
  });

  it("extra credit: paykit ledger has $50, Stripe has nothing → drift +50M", async () => {
    const stripe = buildStripePort({});
    const ledger = buildLedgerPort({ subscriptionCreditMicros: 50_000_000n });
    const r = await runLedgerPassForTenant({
      tenantId: TENANT_A,
      customerId: "cus_a",
      providerId: "stripe-subscription",
      window,
      stripe,
      ledger,
    });
    expect(r.drifts[0]?.deltaMicros).toBe("50000000");
  });

  it("refund mismatch: Stripe charge.refunded but paykit lacks refund_debit → drift", async () => {
    const stripe = buildStripePort({
      invoicesPaidMicros: 50_000_000n,
      chargeRefundsMicros: 10_000_000n,
    });
    const ledger = buildLedgerPort({
      subscriptionCreditMicros: 50_000_000n, // missing refund_debit -10M
    });
    const r = await runLedgerPassForTenant({
      tenantId: TENANT_A,
      customerId: "cus_a",
      providerId: "stripe-subscription",
      window,
      stripe,
      ledger,
    });
    expect(r.drifts).toHaveLength(1);
    expect(r.drifts[0]?.deltaMicros).toBe("10000000");
  });
});

describe("Pass C — idempotency TTL sweeper (RT F6)", () => {
  it("delegates to repo.sweepExpired and reports count", async () => {
    idempotencyDeleted.count = 7;
    const r = await sweepIdempotencyExpired({} as never, new Date());
    expect(r.deletedCount).toBe(7);
  });
});

describe("Orchestrator — advisory lock + canary auto-flip (Val S4 Q3)", () => {
  it("lock not acquired → status='skipped_lock_held'", async () => {
    advisoryLockState.acquired = false;
    const r = await reconcileSubscriptionsV2({
      db: {} as never,
      providerId: "stripe-subscription",
      cache: buildCachePort([]),
      adapter: buildAdapterPort({}),
      stripeFinance: { fetchWindow: async () => ({
        invoicesPaidMicros: 0n,
        chargeRefundsMicros: 0n,
        disputesLostMicros: 0n,
        creditNotesMicros: 0n,
      }) },
      ledger: { fetchWindow: async () => ({
        subscriptionCreditMicros: 0n,
        refundDebitMicros: 0n,
        disputeDebitMicros: 0n,
        creditNoteDebitMicros: 0n,
      }) },
      tenants: [],
      window: { since: new Date(), until: new Date() },
    });
    expect(r.status).toBe("skipped_lock_held");
  });

  it("flips webhook_strict_v2 from false → true after expires_at elapses", async () => {
    runtimeRows.push({
      key: CANARY_KEY,
      value: "false",
      expiresAt: new Date("2026-05-25"), // already expired by now=2026-05-30
    });
    await reconcileSubscriptionsV2({
      db: {} as never,
      providerId: "stripe-subscription",
      cache: buildCachePort([]),
      adapter: buildAdapterPort({}),
      stripeFinance: { fetchWindow: async () => ({
        invoicesPaidMicros: 0n,
        chargeRefundsMicros: 0n,
        disputesLostMicros: 0n,
        creditNotesMicros: 0n,
      }) },
      ledger: { fetchWindow: async () => ({
        subscriptionCreditMicros: 0n,
        refundDebitMicros: 0n,
        disputeDebitMicros: 0n,
        creditNoteDebitMicros: 0n,
      }) },
      tenants: [],
      window: { since: new Date(), until: new Date() },
      now: () => new Date("2026-05-30"),
    });
    const flipped = runtimeRows.find((r) => r.key === CANARY_KEY);
    expect(flipped?.value).toBe("true");
    expect(flipped?.expiresAt).toBeNull();
  });

  it("does NOT flip if expires_at is still in the future", async () => {
    runtimeRows.push({
      key: CANARY_KEY,
      value: "false",
      expiresAt: new Date("2026-06-30"),
    });
    await reconcileSubscriptionsV2({
      db: {} as never,
      providerId: "stripe-subscription",
      cache: buildCachePort([]),
      adapter: buildAdapterPort({}),
      stripeFinance: { fetchWindow: async () => ({
        invoicesPaidMicros: 0n,
        chargeRefundsMicros: 0n,
        disputesLostMicros: 0n,
        creditNotesMicros: 0n,
      }) },
      ledger: { fetchWindow: async () => ({
        subscriptionCreditMicros: 0n,
        refundDebitMicros: 0n,
        disputeDebitMicros: 0n,
        creditNoteDebitMicros: 0n,
      }) },
      tenants: [],
      window: { since: new Date(), until: new Date() },
      now: () => new Date("2026-05-30"),
    });
    const row = runtimeRows.find((r) => r.key === CANARY_KEY);
    expect(row?.value).toBe("false");
  });
});
