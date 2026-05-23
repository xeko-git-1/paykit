import type { AdminGuard, AdminGuardResult } from "@vibecc/paykit";
import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../src/db/client.js";
import { buildAdminLedgerAdjustRoute } from "../src/routes/admin/ledger-adjust-route.js";
import { buildAdminTransactionsRoute } from "../src/routes/admin/transactions-route.js";
import { buildAdminWebhookEventsRoute } from "../src/routes/admin/webhook-events-route.js";

const fakeDb = {
  query: { paymentTransactions: { findFirst: vi.fn(), findMany: vi.fn() } },
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
} as unknown as DbClient;

const denyGuard: AdminGuard = async () => ({ allowed: false });
const allowGuard: AdminGuard = async (): Promise<AdminGuardResult> => ({
  allowed: true,
  adminUserId: "admin-1",
  role: "super_admin",
});
const throwingGuard: AdminGuard = async () => {
  throw new Error("auth service down");
};

describe("admin guard middleware (cross-cutting)", () => {
  it("returns 403 when adminGuard denies", async () => {
    const route = buildAdminTransactionsRoute({ db: fakeDb, adminGuard: denyGuard });
    const res = await route.fetch(new Request("http://localhost/transactions"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 500 with safe message when adminGuard throws (no stack leak)", async () => {
    const route = buildAdminTransactionsRoute({ db: fakeDb, adminGuard: throwingGuard });
    const res = await route.fetch(new Request("http://localhost/transactions"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ADMIN_GUARD_ERROR");
    expect(body.error.message).not.toContain("auth service down"); // no leak
  });

  it("denies on webhook-events route too", async () => {
    const route = buildAdminWebhookEventsRoute({ db: fakeDb, adminGuard: denyGuard });
    const res = await route.fetch(new Request("http://localhost/webhook-events"));
    expect(res.status).toBe(403);
  });

  it("denies on ledger-adjust route too", async () => {
    const route = buildAdminLedgerAdjustRoute({ db: fakeDb, adminGuard: denyGuard });
    const res = await route.fetch(
      new Request("http://localhost/ledger/adjust", { method: "POST" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("admin transactions list — query validation", () => {
  it("rejects unknown provider with 400", async () => {
    const route = buildAdminTransactionsRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(new Request("http://localhost/transactions?provider=paypal"));
    expect(res.status).toBe(400);
  });

  it("rejects unknown status with 400", async () => {
    const route = buildAdminTransactionsRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(new Request("http://localhost/transactions?status=hacked"));
    expect(res.status).toBe(400);
  });

  it("rejects malformed tenantId with 400", async () => {
    const route = buildAdminTransactionsRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(new Request("http://localhost/transactions?tenantId=not-uuid"));
    expect(res.status).toBe(400);
  });
});

describe("admin ledger adjust — body validation", () => {
  it("rejects missing reason with 400", async () => {
    const route = buildAdminLedgerAdjustRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(
      new Request("http://localhost/ledger/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "00000000-0000-0000-0000-000000000001",
          ownerId: "00000000-0000-0000-0000-000000000002",
          amountMicros: "1000000",
          currencyCode: "USD",
          entryType: "credit",
          // reason intentionally missing
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects reason < 3 chars with 400", async () => {
    const route = buildAdminLedgerAdjustRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(
      new Request("http://localhost/ledger/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "00000000-0000-0000-0000-000000000001",
          ownerId: "00000000-0000-0000-0000-000000000002",
          amountMicros: "1000000",
          currencyCode: "USD",
          entryType: "credit",
          reason: "ab",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unsupported currency with 400", async () => {
    const route = buildAdminLedgerAdjustRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(
      new Request("http://localhost/ledger/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "00000000-0000-0000-0000-000000000001",
          ownerId: "00000000-0000-0000-0000-000000000002",
          amountMicros: "1000000",
          currencyCode: "EUR",
          entryType: "credit",
          reason: "manual top up",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects entry_type='refund' (refund must come from webhook, not admin)", async () => {
    const route = buildAdminLedgerAdjustRoute({ db: fakeDb, adminGuard: allowGuard });
    const res = await route.fetch(
      new Request("http://localhost/ledger/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "00000000-0000-0000-0000-000000000001",
          ownerId: "00000000-0000-0000-0000-000000000002",
          amountMicros: "1000000",
          currencyCode: "USD",
          entryType: "refund",
          reason: "manual",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
