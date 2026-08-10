/**
 * Admin refund route characterization test (F7).
 *
 * Locks the branch mapping from refund-core's result state to the admin HTTP
 * response, so the shared-core extract (and any future change to it) cannot
 * silently alter admin refund behaviour. executeRefund is mocked to emit each
 * state; we assert the status + error code the route maps it to, plus the
 * Idempotency-Key requirement and the not-found short-circuit.
 */
import type { AdminGuard, AdminGuardResult } from "@xeko-git-1/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../src/db/client.js";

const executeRefund = vi.fn();
vi.mock("../src/services/refund-core.js", () => ({
  executeRefund: (...args: unknown[]) => executeRefund(...args),
}));

const { buildAdminRefundRoute } = await import("../src/routes/admin/refund-route.js");

const TX_ROW = {
  transactionId: "a0000000-0000-4000-8000-000000000001",
  tenantId: "tenant-1",
  ownerId: "owner-1",
  provider: "sepay",
  amountMicros: "5000000",
  currencyCode: "VND",
  status: "completed",
  providerRef: "ref-1",
};

function makeDb(txRow: unknown = TX_ROW): DbClient {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (txRow ? [txRow] : []),
        }),
      }),
    }),
  } as unknown as DbClient;
}

const allowGuard: AdminGuard = async (): Promise<AdminGuardResult> => ({
  allowed: true,
  adminUserId: "admin-1",
  role: "super_admin",
});

const registry = { get: () => null, list: () => [], register: () => {} } as never;

function buildRoute(txRow: unknown = TX_ROW) {
  return buildAdminRefundRoute({ db: makeDb(txRow), adminGuard: allowGuard, registry });
}

function refundReq(body: Record<string, unknown> = {}, key = "idem-admin-refund-1") {
  return new Request("http://localhost/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      transactionId: TX_ROW.transactionId,
      amountMicros: "1000000",
      reason: "characterization",
      ...body,
    }),
  });
}

beforeEach(() => {
  executeRefund.mockReset();
});

describe("admin refund route — state → HTTP mapping (F7 characterization)", () => {
  it("400 IDEMPOTENCY_KEY_REQUIRED when header missing/too short", async () => {
    const route = buildRoute();
    const res = await route.fetch(
      new Request("http://localhost/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "short" },
        body: JSON.stringify({
          transactionId: TX_ROW.transactionId,
          amountMicros: "1000000",
          reason: "x",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(executeRefund).not.toHaveBeenCalled();
  });

  it("404 NOT_FOUND when the transaction row is absent (before refund runs)", async () => {
    const route = buildRoute(null);
    const res = await route.fetch(refundReq());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(executeRefund).not.toHaveBeenCalled();
  });

  it("completed → 200 state=completed", async () => {
    executeRefund.mockResolvedValue({
      state: "completed",
      inserted: true,
      entryId: "entry-1",
      providerRefundId: "prov-1",
    });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("completed");
  });

  it("completed but not inserted → 200 state=duplicate (idempotent replay)", async () => {
    executeRefund.mockResolvedValue({
      state: "completed",
      inserted: false,
      entryId: "entry-1",
      providerRefundId: "prov-1",
    });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("duplicate");
  });

  it("exceeds_remaining → 400 REFUND_EXCEEDS_REMAINING", async () => {
    executeRefund.mockResolvedValue({ state: "exceeds_remaining", requested: 9n, remaining: 5n });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("REFUND_EXCEEDS_REMAINING");
  });

  it("provider_unknown → 500 ADMIN_REFUND_PROVIDER_UNKNOWN", async () => {
    executeRefund.mockResolvedValue({ state: "provider_unknown", provider: "ghost" });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("ADMIN_REFUND_PROVIDER_UNKNOWN");
  });

  it("unsupported → 501 with alternativeAction hint", async () => {
    executeRefund.mockResolvedValue({
      state: "unsupported",
      code: "REFUND_UNSUPPORTED",
      message: "provider cannot refund",
    });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("REFUND_UNSUPPORTED");
    expect(body.error.alternativeAction).toBe("POST /admin/billing/ledger/adjust");
  });

  it("failed → 502", async () => {
    executeRefund.mockResolvedValue({
      state: "failed",
      code: "PROVIDER_ERROR",
      message: "gateway down",
    });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("PROVIDER_ERROR");
  });

  it("pending → 200 state=pending", async () => {
    executeRefund.mockResolvedValue({ state: "pending", pendingId: "pend-1" });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("pending");
  });

  it("pending_webhook → 202 state=pending_webhook", async () => {
    executeRefund.mockResolvedValue({
      state: "pending_webhook",
      transactionId: TX_ROW.transactionId,
      providerCode: "PARTIALLY_REFUNDED",
    });
    const res = await buildRoute().fetch(refundReq());
    expect(res.status).toBe(202);
    expect((await res.json()).data.state).toBe("pending_webhook");
  });
});
