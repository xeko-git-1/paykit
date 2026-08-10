/**
 * Tenant-scoping regression test — locks the invariant that route handlers
 * pass the correct authenticated tenantId to repo functions.
 *
 * This is the characterization test (RED phase lock) that must PASS on the
 * current tree before any refactor, and continue passing after the auth
 * middleware migration.
 *
 * Tests BOTH paths:
 * 1. Embedded mode: tenantResolver provides tenant → repo called with that tenantId
 * 2. Service mode: paykitAuth context provides tenant → repo called with that tenantId
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildBalanceRoute } from "../src/routes/billing/balance-route.js";

// Mock the balance repo at module level
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js", () => ({
  listBalancesByTenant: vi.fn().mockResolvedValue([
    {
      currencyCode: "USD",
      currentBalanceMicros: "50000000",
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    },
  ]),
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  computeBalancesByTenant: vi.fn().mockResolvedValue([
    { currencyCode: "USD", totalMicros: "50000000" },
  ]),
}));

import { listBalancesByTenant } from "@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js";
import { computeBalancesByTenant } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";

const TENANT_A = { tenantId: "tenant-aaa-111", ownerId: "owner-aaa-111" };
const TENANT_B = { tenantId: "tenant-bbb-222", ownerId: "owner-bbb-222" };

const fakeDb = {} as never;

describe("tenant-scoping regression: balance route", () => {
  describe("embedded mode (tenantResolver path)", () => {
    it("passes the resolved tenantId to listBalancesByTenant", async () => {
      const app = new Hono();
      app.route(
        "/",
        buildBalanceRoute({
          db: fakeDb,
          tenantResolver: async () => TENANT_A,
        }),
      );

      vi.mocked(listBalancesByTenant).mockClear();

      const res = await app.request("/balance");
      expect(res.status).toBe(200);

      // The critical assertion: repo was called with the CORRECT tenantId
      expect(listBalancesByTenant).toHaveBeenCalledWith(fakeDb, TENANT_A.tenantId);
    });

    it("passes tenant B tenantId when resolver returns tenant B", async () => {
      const app = new Hono();
      app.route(
        "/",
        buildBalanceRoute({
          db: fakeDb,
          tenantResolver: async () => TENANT_B,
        }),
      );

      vi.mocked(listBalancesByTenant).mockClear();

      const res = await app.request("/balance");
      expect(res.status).toBe(200);

      expect(listBalancesByTenant).toHaveBeenCalledWith(fakeDb, TENANT_B.tenantId);
    });

    it("passes correct tenantId to computeBalancesByTenant on /balance/computed", async () => {
      const app = new Hono();
      app.route(
        "/",
        buildBalanceRoute({
          db: fakeDb,
          tenantResolver: async () => TENANT_A,
        }),
      );

      vi.mocked(computeBalancesByTenant).mockClear();

      const res = await app.request("/balance/computed");
      expect(res.status).toBe(200);

      expect(computeBalancesByTenant).toHaveBeenCalledWith(fakeDb, TENANT_A.tenantId);
    });
  });

  describe("service mode (paykitAuth context path)", () => {
    it("passes the auth context tenantId to listBalancesByTenant", async () => {
      const app = new Hono();

      // Simulate auth middleware setting paykitAuth before the route
      app.use("*", async (c, next) => {
        c.set("paykitAuth", {
          merchantId: "merchant-1",
          tenant: TENANT_A,
          scopes: ["balance:read"],
          plane: "api_key" as const,
        });
        await next();
      });

      app.route("/", buildBalanceRoute({ db: fakeDb }));

      vi.mocked(listBalancesByTenant).mockClear();

      const res = await app.request("/balance");
      expect(res.status).toBe(200);

      // The critical assertion: repo was called with the auth context tenantId
      expect(listBalancesByTenant).toHaveBeenCalledWith(fakeDb, TENANT_A.tenantId);
    });

    it("passes tenant B from auth context correctly", async () => {
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("paykitAuth", {
          merchantId: "merchant-2",
          tenant: TENANT_B,
          scopes: ["balance:read"],
          plane: "api_key" as const,
        });
        await next();
      });

      app.route("/", buildBalanceRoute({ db: fakeDb }));

      vi.mocked(listBalancesByTenant).mockClear();

      const res = await app.request("/balance");
      expect(res.status).toBe(200);

      expect(listBalancesByTenant).toHaveBeenCalledWith(fakeDb, TENANT_B.tenantId);
    });

    it("returns 401 when no auth context and no tenantResolver (fail-closed)", async () => {
      const app = new Hono();
      // No auth middleware, no tenantResolver — service mode fail-closed
      app.route("/", buildBalanceRoute({ db: fakeDb }));

      const res = await app.request("/balance");
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error.code).toBe("AUTH_REQUIRED");
    });
  });

  describe("paykitAuth takes precedence over tenantResolver", () => {
    it("uses auth context tenant even when tenantResolver is provided", async () => {
      const app = new Hono();

      // Auth middleware sets tenant A
      app.use("*", async (c, next) => {
        c.set("paykitAuth", {
          merchantId: "merchant-1",
          tenant: TENANT_A,
          scopes: ["balance:read"],
          plane: "api_key" as const,
        });
        await next();
      });

      // tenantResolver would return tenant B — but should NOT be used
      const resolverSpy = vi.fn().mockResolvedValue(TENANT_B);
      app.route("/", buildBalanceRoute({ db: fakeDb, tenantResolver: resolverSpy }));

      vi.mocked(listBalancesByTenant).mockClear();

      const res = await app.request("/balance");
      expect(res.status).toBe(200);

      // Auth context wins — repo called with tenant A, not B
      expect(listBalancesByTenant).toHaveBeenCalledWith(fakeDb, TENANT_A.tenantId);
      // tenantResolver was never called
      expect(resolverSpy).not.toHaveBeenCalled();
    });
  });
});
