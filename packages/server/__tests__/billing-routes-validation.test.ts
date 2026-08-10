import { TenantResolutionError } from "@xeko-git-1/paykit";
import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { buildBalanceRoute } from "../src/routes/billing/balance-route.js";
import { buildLedgerRoute } from "../src/routes/billing/ledger-route.js";
import { buildPaymentHistoryRoute } from "../src/routes/billing/payment-history-route.js";

// Stub DbClient — only the methods called by the routes need to exist.
const fakeDb = {
  query: { paymentTransactions: { findFirst: vi.fn(), findMany: vi.fn() } },
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
} as unknown as DbClient;

const goodTenant = async () => ({ tenantId: "t-1", ownerId: "o-1" });
const throwingTenant = async () => {
  throw new TenantResolutionError("not signed in");
};

describe("balance route — auth flow", () => {
  it("returns 401 when TenantResolver throws TenantResolutionError", async () => {
    const route = buildBalanceRoute({ db: fakeDb, tenantResolver: throwingTenant });
    const res = await route.fetch(new Request("http://localhost/balance"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TENANT_RESOLUTION_ERROR");
  });

  it("returns 401 when TenantResolver throws unknown error", async () => {
    const route = buildBalanceRoute({
      db: fakeDb,
      tenantResolver: async () => {
        throw new Error("boom");
      },
    });
    const res = await route.fetch(new Request("http://localhost/balance"));
    expect(res.status).toBe(401);
  });
});

describe("ledger route — query validation", () => {
  it("rejects limit > 200 with 400", async () => {
    const route = buildLedgerRoute({ db: fakeDb, tenantResolver: goodTenant });
    const res = await route.fetch(new Request("http://localhost/ledger?limit=5000"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown entryType with 400", async () => {
    const route = buildLedgerRoute({ db: fakeDb, tenantResolver: goodTenant });
    const res = await route.fetch(new Request("http://localhost/ledger?entryType=hack"));
    expect(res.status).toBe(400);
  });

  it("rejects unknown currencyCode with 400", async () => {
    const route = buildLedgerRoute({ db: fakeDb, tenantResolver: goodTenant });
    const res = await route.fetch(new Request("http://localhost/ledger?currencyCode=EUR"));
    expect(res.status).toBe(400);
  });

  it("returns 401 when tenant resolution fails", async () => {
    const route = buildLedgerRoute({ db: fakeDb, tenantResolver: throwingTenant });
    const res = await route.fetch(new Request("http://localhost/ledger"));
    expect(res.status).toBe(401);
  });
});

describe("payment-history route — query validation", () => {
  it("rejects status outside enum with 400", async () => {
    const route = buildPaymentHistoryRoute({ db: fakeDb, tenantResolver: goodTenant });
    const res = await route.fetch(new Request("http://localhost/payments?status=revoked"));
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const route = buildPaymentHistoryRoute({ db: fakeDb, tenantResolver: goodTenant });
    const res = await route.fetch(new Request("http://localhost/payments?limit=500"));
    expect(res.status).toBe(400);
  });

  it("rejects page < 1 with 400", async () => {
    const route = buildPaymentHistoryRoute({ db: fakeDb, tenantResolver: goodTenant });
    const res = await route.fetch(new Request("http://localhost/payments?page=0"));
    expect(res.status).toBe(400);
  });

  it("returns 401 when tenant resolution fails", async () => {
    const route = buildPaymentHistoryRoute({ db: fakeDb, tenantResolver: throwingTenant });
    const res = await route.fetch(new Request("http://localhost/payments"));
    expect(res.status).toBe(401);
  });
});
