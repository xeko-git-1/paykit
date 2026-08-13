/**
 * GET /refunds/overdue-webhooks — the operator's queue of refunds whose
 * confirmation webhook never came.
 *
 * Pinned here: the admin guard fences the route, the default window matches the
 * sweeper's 24h, `olderThanHours` moves the cutoff, query validation rejects
 * garbage, and the response carries what the runbook needs (who, how much,
 * since when, and whether the sweeper already reported it).
 */
import type { AdminGuard, AdminGuardResult } from "@xeko-git-1/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/refund-overdue.repo.js", () => ({
  REFUND_WEBHOOK_OVERDUE_KEY: "refund_webhook_overdue_at",
  markOverdueRefundWebhooks: vi.fn(),
  listOverdueRefundWebhooks: listMock,
}));

import { buildAdminRefundOverdueRoute } from "../src/routes/admin/refund-overdue-route.js";

const NOW = new Date("2026-08-13T12:00:00Z");

const denyGuard: AdminGuard = async () => ({ allowed: false });
const allowGuard: AdminGuard = async (): Promise<AdminGuardResult> => ({
  allowed: true,
  adminUserId: "admin-1",
  role: "super_admin",
});

function route(guard: AdminGuard = allowGuard) {
  return buildAdminRefundOverdueRoute({
    db: {} as never,
    adminGuard: guard,
    now: () => NOW,
  });
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([]);
});

describe("GET /refunds/overdue-webhooks", () => {
  it("is fenced by the admin guard", async () => {
    const res = await route(denyGuard).fetch(
      new Request("http://localhost/refunds/overdue-webhooks"),
    );
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("defaults the window to 24h, matching the sweeper", async () => {
    const res = await route().fetch(new Request("http://localhost/refunds/overdue-webhooks"));

    expect(res.status).toBe(200);
    const opts = listMock.mock.calls[0]?.[1] as { cutoff: Date; limit: number; offset: number };
    expect(opts.cutoff).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
    expect(opts.limit).toBe(50);
    expect(opts.offset).toBe(0);
  });

  it("moves the cutoff with olderThanHours", async () => {
    await route().fetch(
      new Request("http://localhost/refunds/overdue-webhooks?olderThanHours=1&limit=10&offset=5"),
    );

    const opts = listMock.mock.calls[0]?.[1] as { cutoff: Date; limit: number; offset: number };
    expect(opts.cutoff).toEqual(new Date(NOW.getTime() - 60 * 60 * 1000));
    expect(opts.limit).toBe(10);
    expect(opts.offset).toBe(5);
  });

  it("rejects a non-numeric window with 400", async () => {
    const res = await route().fetch(
      new Request("http://localhost/refunds/overdue-webhooks?olderThanHours=soon"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns what the runbook needs, including whether the sweeper reported it", async () => {
    listMock.mockResolvedValue([
      {
        transactionId: "10000000-0000-4000-8000-000000000001",
        tenantId: "20000000-0000-4000-8000-000000000002",
        provider: "nowpayments",
        amountMicros: "5000000",
        currencyCode: "USD",
        pendingSince: new Date("2026-08-11T12:00:00Z"),
        overdueAt: "2026-08-12T12:10:00.000Z",
      },
      {
        transactionId: "10000000-0000-4000-8000-000000000003",
        tenantId: "20000000-0000-4000-8000-000000000002",
        provider: "bitpay",
        amountMicros: "1000000",
        currencyCode: "USD",
        pendingSince: new Date("2026-08-12T11:00:00Z"),
        overdueAt: null, // crossed the threshold, no sweep has ticked yet
      },
    ]);

    const res = await route().fetch(new Request("http://localhost/refunds/overdue-webhooks"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { refunds: Record<string, unknown>[]; pagination: Record<string, number> };
    };
    expect(body.data.refunds).toHaveLength(2);
    expect(body.data.refunds[0]).toEqual({
      transactionId: "10000000-0000-4000-8000-000000000001",
      tenantId: "20000000-0000-4000-8000-000000000002",
      provider: "nowpayments",
      amountMicros: "5000000",
      currencyCode: "USD",
      pendingSince: "2026-08-11T12:00:00.000Z",
      overdueAt: "2026-08-12T12:10:00.000Z",
    });
    expect(body.data.refunds[1]).toMatchObject({ overdueAt: null });
    expect(body.data.pagination).toEqual({ limit: 50, offset: 0 });
  });
});
