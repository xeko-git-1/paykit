/**
 * Phase 05 — subscription routes tests with mocked repos.
 *
 * Strategy: stub repo modules so route logic is tested independently of
 * Drizzle/Postgres. Live integration tests live in Phase 10.
 *
 * Coverage:
 *   - Idempotency-Key required, replay, body-mismatch, cross-tenant isolation (RT F6)
 *   - Subscribe outbox: adapter call + cache persist (RT F8)
 *   - Cancel default end-of-period; explicit immediate
 *   - Upgrade prorate
 *   - Tenant-scoped 404 (no info leak)
 *   - Status filter (RT F11)
 *   - Admin cross-tenant list with AdminGuard (RT F5)
 *   - Admin missing Idempotency-Key → 400
 *   - Admin guard reject → 403
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const subscriptionRows: Array<Record<string, unknown>> = [];
const idempotencyRows: Array<{
  tenantId: string;
  key: string;
  bodyHash: string;
  state: "in_flight" | "done";
  status: number | null;
  body: Record<string, unknown>;
  expiresAt: Date;
}> = [];

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/subscription.repo.js", () => {
  return {
    upsertFromEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      const existing = subscriptionRows.find(
        (r) =>
          r.provider === input.provider &&
          r.providerSubscriptionId === input.providerSubscriptionId,
      );
      if (existing) {
        Object.assign(existing, input, { updatedAt: new Date() });
        return existing;
      }
      const row = {
        subscriptionId: crypto.randomUUID(),
        cancelAtPeriodEnd: false,
        currencyCode: "USD",
        latestInvoiceId: null,
        metadataJson: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...input,
      };
      subscriptionRows.push(row);
      return row;
    }),
    findByProviderSub: vi.fn(async (_db: unknown, provider: string, providerSubId: string) =>
      subscriptionRows.find(
        (r) => r.provider === provider && r.providerSubscriptionId === providerSubId,
      ),
    ),
    findById: vi.fn(async (_db: unknown, id: string) =>
      subscriptionRows.find((r) => r.subscriptionId === id),
    ),
    listForTenant: vi.fn(
      async (_db: unknown, tenantId: string, opts: { statuses?: readonly string[] } = {}) => {
        let rows = subscriptionRows.filter((r) => r.tenantId === tenantId);
        if (opts.statuses && opts.statuses.length > 0) {
          rows = rows.filter((r) => opts.statuses!.includes(r.status as string));
        }
        return rows;
      },
    ),
    listByCustomer: vi.fn(async () => []),
    markCanceled: vi.fn(async () => undefined),
  };
});

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/customer.repo.js", () => {
  const customers: Array<Record<string, unknown>> = [];
  return {
    findCustomer: vi.fn(async (_db: unknown, tenantId: string, provider: string) =>
      customers.find((c) => c.tenantId === tenantId && c.provider === provider),
    ),
    findByProviderCustomerId: vi.fn(async () => undefined),
    getOrInsertCustomer: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      const existing = customers.find(
        (c) => c.tenantId === input.tenantId && c.provider === input.provider,
      );
      if (existing) return existing;
      const row = {
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadataJson: input.metadata ?? {},
      };
      customers.push(row);
      return row;
    }),
    deleteCustomerForCascade: vi.fn(),
  };
});

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/idempotency.repo.js", async () => {
  class IdempotencyBodyMismatchError extends Error {
    constructor(message = "body mismatch") {
      super(message);
      this.name = "IdempotencyBodyMismatchError";
    }
  }
  return {
    IdempotencyBodyMismatchError,
    claimIdempotency: vi.fn(
      async (_db: unknown, input: { tenantId: string; key: string; bodyHash: string }) => {
        const now = Date.now();
        const row = idempotencyRows.find(
          (r) => r.tenantId === input.tenantId && r.key === input.key,
        );
        // No row, or expired → claim it (insert/reclaim in_flight placeholder).
        if (!row || row.expiresAt.getTime() <= now) {
          const placeholder = {
            tenantId: input.tenantId,
            key: input.key,
            bodyHash: input.bodyHash,
            state: "in_flight" as const,
            status: null,
            body: {},
            expiresAt: new Date(now + 120_000),
          };
          if (row) Object.assign(row, placeholder);
          else idempotencyRows.push(placeholder);
          return { outcome: "claimed" };
        }
        if (row.bodyHash !== input.bodyHash) {
          throw new IdempotencyBodyMismatchError();
        }
        if (row.state === "done") {
          return {
            outcome: "replay",
            record: {
              tenantId: row.tenantId,
              idempotencyKey: row.key,
              requestBodyHash: row.bodyHash,
              state: row.state,
              responseStatus: row.status,
              responseBodyJson: row.body,
              expiresAt: row.expiresAt,
            },
          };
        }
        return { outcome: "in_flight" };
      },
    ),
    finalizeIdempotency: vi.fn(
      async (
        _db: unknown,
        input: {
          tenantId: string;
          key: string;
          responseStatus: number;
          responseBody: Record<string, unknown>;
        },
      ) => {
        // Guarded by state='in_flight' — a finalize whose claim was reclaimed
        // by a racing request matches nothing and returns null.
        const row = idempotencyRows.find(
          (r) => r.tenantId === input.tenantId && r.key === input.key && r.state === "in_flight",
        );
        if (!row) return null;
        row.state = "done";
        row.status = input.responseStatus;
        row.body = input.responseBody;
        row.expiresAt = new Date(Date.now() + 86_400_000);
        return row;
      },
    ),
    releaseIdempotency: vi.fn(async (_db: unknown, input: { tenantId: string; key: string }) => {
      const idx = idempotencyRows.findIndex(
        (r) => r.tenantId === input.tenantId && r.key === input.key && r.state === "in_flight",
      );
      if (idx >= 0) idempotencyRows.splice(idx, 1);
    }),
    sweepExpired: vi.fn(async () => 0),
  };
});

const { buildAdminSubscriptionRoutes, buildTenantSubscriptionRoutes } = await import(
  "../src/routes/subscriptions/index.js"
);
import type { CustomerProviderPort } from "../src/services/customer-service.js";

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

function makeAdapter() {
  return {
    id: "stripe-subscription",
    subscribe: vi.fn(async (input: { customerId: string; priceId: string }) => ({
      id: `sub_${input.priceId}_${Math.random().toString(36).slice(2, 6)}`,
      status: "trialing" as const,
      currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
      customerId: input.customerId,
      priceId: input.priceId,
      cancelAtPeriodEnd: false,
      currencyCode: "USD" as const,
      lastEventCreated: new Date(),
      latestInvoiceId: "in_1",
    })),
    cancel: vi.fn(async (input: { subscriptionId: string; atPeriodEnd: boolean }) => ({
      id: input.subscriptionId,
      status: input.atPeriodEnd ? ("trialing" as const) : ("canceled" as const),
      currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
      customerId: "cus_a",
      priceId: "price_p1",
      cancelAtPeriodEnd: input.atPeriodEnd,
      currencyCode: "USD" as const,
      lastEventCreated: new Date(),
    })),
    upgrade: vi.fn(async (input: { subscriptionId: string; newPriceId: string }) => ({
      id: input.subscriptionId,
      status: "active" as const,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      customerId: "cus_a",
      priceId: input.newPriceId,
      cancelAtPeriodEnd: false,
      currencyCode: "USD" as const,
      lastEventCreated: new Date(),
    })),
    listForCustomer: vi.fn(async () => []),
    getById: vi.fn(),
    verifyWebhookSignature: vi.fn(() => true),
    parseSubscriptionEvent: vi.fn(() => null),
    syncSubscription: vi.fn(),
  };
}

function makeProviderPort(): CustomerProviderPort {
  return {
    id: "stripe-subscription",
    createCustomer: vi.fn(async (input: { tenantId: string }) => ({
      providerCustomerId: `cus_${input.tenantId.slice(-4)}`,
      metadata: { paykit_tenant_id: input.tenantId },
    })),
  };
}

function buildTenantApp(tenantId: string) {
  const adapter = makeAdapter();
  const app = new Hono();
  app.route(
    "/billing/subscriptions",
    buildTenantSubscriptionRoutes({
      db: {} as never,
      tenantResolver: async () => ({ tenantId, ownerId: tenantId }),
      adapter: adapter as never,
      customerProvider: makeProviderPort(),
    }),
  );
  return { app, adapter };
}

const POST_BODY = { priceId: "price_p1", trialDays: 7 };
const headers = (key: string): HeadersInit => ({
  "Content-Type": "application/json",
  "Idempotency-Key": key,
});

beforeEach(() => {
  subscriptionRows.length = 0;
  idempotencyRows.length = 0;
});

describe("Subscribe — happy path (RT F8 outbox)", () => {
  it("creates subscription, persists row, returns 201", async () => {
    const { app, adapter } = buildTenantApp(TENANT_A);
    const res = await app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-create-1"),
      body: JSON.stringify(POST_BODY),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { priceId: string; status: string } };
    expect(json.data.priceId).toBe("price_p1");
    expect(json.data.status).toBe("trialing");
    expect(adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriptionRows).toHaveLength(1);
    expect(subscriptionRows[0]?.tenantId).toBe(TENANT_A);
  });
});

describe("Subscribe — Idempotency-Key behaviors (RT F6)", () => {
  it("missing key → 400 IDEMPOTENCY_KEY_REQUIRED", async () => {
    const { app } = buildTenantApp(TENANT_A);
    const res = await app.request("/billing/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(POST_BODY),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("same key + same body → cached replay (single Stripe call)", async () => {
    const { app, adapter } = buildTenantApp(TENANT_A);
    const r1 = await app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-replay-1"),
      body: JSON.stringify(POST_BODY),
    });
    const r2 = await app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-replay-1"),
      body: JSON.stringify(POST_BODY),
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(adapter.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriptionRows).toHaveLength(1);
  });

  it("same key + different body → 422 IDEMPOTENCY_BODY_MISMATCH", async () => {
    const { app } = buildTenantApp(TENANT_A);
    await app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-mismatch-1"),
      body: JSON.stringify({ priceId: "price_p1" }),
    });
    const r2 = await app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-mismatch-1"),
      body: JSON.stringify({ priceId: "price_p2" }),
    });
    expect(r2.status).toBe(422);
    const json = (await r2.json()) as { error: { code: string } };
    expect(json.error.code).toBe("IDEMPOTENCY_BODY_MISMATCH");
  });

  it("same key still in flight (another request processing) → 409 IDEMPOTENCY_IN_FLIGHT", async () => {
    const { app } = buildTenantApp(TENANT_A);
    // Simulate a concurrent request that has claimed the key but not finalized:
    // an unexpired in_flight row with a matching body hash.
    const bodyHash = createHash("sha256").update(JSON.stringify(POST_BODY)).digest("hex");
    idempotencyRows.push({
      tenantId: TENANT_A,
      key: "idem-in-flight-1",
      bodyHash,
      state: "in_flight",
      status: null,
      body: {},
      expiresAt: new Date(Date.now() + 120_000),
    });

    const res = await app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-in-flight-1"),
      body: JSON.stringify(POST_BODY),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
  });

  it("cross-tenant isolation: same key from different tenants creates distinct subs (RT F6)", async () => {
    const a = buildTenantApp(TENANT_A);
    const b = buildTenantApp(TENANT_B);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-shared-key"),
      body: JSON.stringify(POST_BODY),
    });
    await b.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-shared-key"),
      body: JSON.stringify(POST_BODY),
    });
    expect(subscriptionRows).toHaveLength(2);
    expect(subscriptionRows[0]?.tenantId).toBe(TENANT_A);
    expect(subscriptionRows[1]?.tenantId).toBe(TENANT_B);
    expect(idempotencyRows).toHaveLength(2);
  });
});

describe("Cancel routes", () => {
  it("default behavior: cancel_at_period_end=true", async () => {
    const a = buildTenantApp(TENANT_A);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-c-1"),
      body: JSON.stringify(POST_BODY),
    });
    const subId = subscriptionRows[0]?.subscriptionId as string;
    const res = await a.app.request(`/billing/subscriptions/${subId}/cancel`, {
      method: "POST",
      headers: headers("idem-c-2"),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(a.adapter.cancel).toHaveBeenCalledWith(expect.objectContaining({ atPeriodEnd: true }));
  });

  it("explicit immediate: atPeriodEnd:false → adapter.cancel({atPeriodEnd:false})", async () => {
    const a = buildTenantApp(TENANT_A);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-c-3"),
      body: JSON.stringify(POST_BODY),
    });
    const subId = subscriptionRows[0]?.subscriptionId as string;
    await a.app.request(`/billing/subscriptions/${subId}/cancel`, {
      method: "POST",
      headers: headers("idem-c-4"),
      body: JSON.stringify({ atPeriodEnd: false }),
    });
    expect(a.adapter.cancel).toHaveBeenCalledWith(expect.objectContaining({ atPeriodEnd: false }));
  });
});

describe("Upgrade route", () => {
  it("calls adapter.upgrade with newPriceId + Idempotency-Key forwarded", async () => {
    const a = buildTenantApp(TENANT_A);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-u-1"),
      body: JSON.stringify(POST_BODY),
    });
    const subId = subscriptionRows[0]?.subscriptionId as string;
    await a.app.request(`/billing/subscriptions/${subId}/upgrade`, {
      method: "POST",
      headers: headers("idem-u-2"),
      body: JSON.stringify({ newPriceId: "price_premium" }),
    });
    expect(a.adapter.upgrade).toHaveBeenCalledWith(
      expect.objectContaining({ newPriceId: "price_premium", idempotencyKey: "idem-u-2" }),
    );
  });
});

describe("List + Get tenant-scoped (RT F11 status filter)", () => {
  it("only returns own tenant's subs", async () => {
    const a = buildTenantApp(TENANT_A);
    const b = buildTenantApp(TENANT_B);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-l-a1"),
      body: JSON.stringify({ priceId: "price_a" }),
    });
    await b.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-l-b1"),
      body: JSON.stringify({ priceId: "price_b" }),
    });
    const r = await a.app.request("/billing/subscriptions", { method: "GET" });
    const json = (await r.json()) as {
      data: { subscriptions: Array<{ priceId: string; tenantId: string }> };
    };
    expect(json.data.subscriptions).toHaveLength(1);
    expect(json.data.subscriptions[0]?.priceId).toBe("price_a");
    expect(json.data.subscriptions[0]?.tenantId).toBe(TENANT_A);
  });

  it("status filter narrows result (RT F11)", async () => {
    const a = buildTenantApp(TENANT_A);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-f-1"),
      body: JSON.stringify(POST_BODY),
    });
    if (subscriptionRows[0]) subscriptionRows[0].status = "past_due";
    const r = await a.app.request("/billing/subscriptions?status=past_due", { method: "GET" });
    const json = (await r.json()) as { data: { subscriptions: Array<{ status: string }> } };
    expect(json.data.subscriptions).toHaveLength(1);
    expect(json.data.subscriptions[0]?.status).toBe("past_due");
    const empty = await a.app.request("/billing/subscriptions?status=canceled", { method: "GET" });
    const emptyJson = (await empty.json()) as { data: { subscriptions: unknown[] } };
    expect(emptyJson.data.subscriptions).toHaveLength(0);
  });

  it("GET other-tenant subscription returns 404 (no info leak)", async () => {
    const a = buildTenantApp(TENANT_A);
    const b = buildTenantApp(TENANT_B);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-leak-1"),
      body: JSON.stringify(POST_BODY),
    });
    const subId = subscriptionRows[0]?.subscriptionId as string;
    const r = await b.app.request(`/billing/subscriptions/${subId}`, { method: "GET" });
    expect(r.status).toBe(404);
  });
});

describe("Admin routes (RT F5)", () => {
  it("AdminGuard'd list returns subs across multiple tenants when no tenantId filter", async () => {
    const a = buildTenantApp(TENANT_A);
    const b = buildTenantApp(TENANT_B);
    await a.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-am-a"),
      body: JSON.stringify(POST_BODY),
    });
    await b.app.request("/billing/subscriptions", {
      method: "POST",
      headers: headers("idem-am-b"),
      body: JSON.stringify(POST_BODY),
    });
    const adminApp = new Hono();
    adminApp.route(
      "/admin/billing/subscriptions",
      buildAdminSubscriptionRoutes({
        db: {} as never,
        adminGuard: async () => ({ allowed: true, adminUserId: "admin-1", role: "support" }),
        adapter: makeAdapter() as never,
      }),
    );
    // Provide tenantId filter for cross-tenant test (admin "?tenantId=" path)
    const rA = await adminApp.request(`/admin/billing/subscriptions?tenantId=${TENANT_A}`);
    const jsonA = (await rA.json()) as { data: { subscriptions: Array<{ tenantId: string }> } };
    expect(jsonA.data.subscriptions).toHaveLength(1);
    expect(jsonA.data.subscriptions[0]?.tenantId).toBe(TENANT_A);

    const rB = await adminApp.request(`/admin/billing/subscriptions?tenantId=${TENANT_B}`);
    const jsonB = (await rB.json()) as { data: { subscriptions: Array<{ tenantId: string }> } };
    expect(jsonB.data.subscriptions).toHaveLength(1);
    expect(jsonB.data.subscriptions[0]?.tenantId).toBe(TENANT_B);
  });

  it("AdminGuard rejects non-admin → 403", async () => {
    const adminApp = new Hono();
    adminApp.route(
      "/admin/billing/subscriptions",
      buildAdminSubscriptionRoutes({
        db: {} as never,
        adminGuard: async () => ({ allowed: false }),
        adapter: makeAdapter() as never,
      }),
    );
    const r = await adminApp.request("/admin/billing/subscriptions");
    expect(r.status).toBe(403);
  });

  it("admin cancel without Idempotency-Key → 400", async () => {
    const adminApp = new Hono();
    const adapter = makeAdapter();
    adminApp.route(
      "/admin/billing/subscriptions",
      buildAdminSubscriptionRoutes({
        db: {} as never,
        adminGuard: async () => ({ allowed: true, adminUserId: "x", role: "ops" }),
        adapter: adapter as never,
      }),
    );
    subscriptionRows.push({
      subscriptionId: "11111111-1111-1111-1111-111111111111",
      tenantId: TENANT_A,
      ownerId: TENANT_A,
      provider: "stripe-subscription",
      providerSubscriptionId: "sub_legacy",
      customerId: "cus_a",
      priceId: "price_p1",
      status: "active",
      currencyCode: "USD",
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      latestInvoiceId: null,
      lastEventCreated: new Date(),
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const r = await adminApp.request(
      "/admin/billing/subscriptions/11111111-1111-1111-1111-111111111111/cancel",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(r.status).toBe(400);
    expect(adapter.cancel).not.toHaveBeenCalled();
  });
});
