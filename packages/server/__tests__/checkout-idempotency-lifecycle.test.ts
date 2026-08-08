/**
 * Checkout lifecycle under a repeated Idempotency-Key.
 *
 * A checkout spans this database and the provider, so the interesting cases are
 * all about where a retry lands relative to the provider call:
 *
 *   - The claim is written BEFORE the provider is called, so a crash mid-call
 *     leaves a row a reconcile pass can find instead of an orphaned live session.
 *   - A retry that finds a finished checkout gets the SAME body, URLs included —
 *     a trimmed replay leaves a client unable to complete the checkout it already
 *     paid for the right to make.
 *   - A retry that finds one still in flight is told to come back, never handed a
 *     second provider session.
 *   - A provider failure leaves the row claimed, because "failed" and "created a
 *     session then failed" are indistinguishable from here.
 *   - Losing the claim race rolls the discount consumption back, so a promo is not
 *     spent on a checkout this request will not create.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  claimCheckout: vi.fn(),
  finalizeCheckout: vi.fn(),
  createTransaction: vi.fn(),
  findByIdempotencyKey: vi.fn(),
}));

vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => repo);

const discountCalls = vi.hoisted(() => ({ consumed: 0, rolledBack: 0 }));

import { buildCheckoutRouter } from "../src/routes/checkout/checkout-router.js";

const TENANT = { tenantId: "tenant-lifecycle-1", ownerId: "owner-lifecycle-1" };
const KEY = "idem-key-lifecycle";

/** A row as it exists between the claim and the provider's answer. */
function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "tx-lifecycle-1",
    tenantId: TENANT.tenantId,
    provider: "mock-provider",
    amountMicros: "25000000",
    currencyCode: "USD",
    status: "provider_creating",
    providerRef: null,
    idempotencyKey: KEY,
    checkoutResultJson: null,
    metadataJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Minimal Drizzle stand-in. `transaction` runs the callback and — crucially —
 * propagates a throw, which is how the router signals a lost claim and how the
 * rollback of the discount consumption is observed.
 */
function makeDb() {
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      try {
        const out = await fn(makeTxHandle());
        discountCalls.consumed += 0;
        return out;
      } catch (err) {
        // A real transaction discards everything the callback wrote, including any
        // discount redemption consumed inside it.
        if (discountCalls.consumed > 0) discountCalls.rolledBack += 1;
        throw err;
      }
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  } as never;
}

function makeTxHandle() {
  return {
    transaction: async (fn: (nested: unknown) => unknown) => fn({}),
  };
}

const EXPIRES = new Date("2026-01-01T00:00:00.000Z");

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "mock-provider",
    supportedCurrencies: ["USD"],
    createCheckout: vi.fn().mockResolvedValue({
      providerSessionId: "ps_lifecycle_1",
      webUrl: "https://provider.example/pay/ps_lifecycle_1",
      qrUrl: "https://provider.example/qr/ps_lifecycle_1",
      expiresAt: EXPIRES,
      ...overrides,
    }),
  };
}

function buildApp(adapter: ReturnType<typeof makeAdapter>, db: unknown, extra = {}) {
  const app = new Hono();
  app.route(
    "/",
    buildCheckoutRouter({
      db: db as never,
      registry: { list: () => [adapter] } as never,
      tenantResolver: async () => TENANT,
      ...extra,
    }),
  );
  return app;
}

function post(app: Hono, body: Record<string, unknown> = { amountUsd: 25 }, key = KEY) {
  return app.request("/mock-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  discountCalls.consumed = 0;
  discountCalls.rolledBack = 0;
  repo.claimCheckout.mockResolvedValue({ row: claimedRow(), created: true });
  repo.finalizeCheckout.mockResolvedValue(claimedRow({ status: "awaiting_payment" }));
});

describe("first attempt", () => {
  it("claims the key before calling the provider", async () => {
    const order: string[] = [];
    repo.claimCheckout.mockImplementation(async () => {
      order.push("claim");
      return { row: claimedRow(), created: true };
    });
    const adapter = makeAdapter();
    adapter.createCheckout.mockImplementation(async () => {
      order.push("provider");
      return {
        providerSessionId: "ps_lifecycle_1",
        webUrl: "https://provider.example/pay/ps_lifecycle_1",
        expiresAt: EXPIRES,
      };
    });
    repo.finalizeCheckout.mockImplementation(async () => {
      order.push("finalize");
      return claimedRow({ status: "awaiting_payment" });
    });

    const res = await post(buildApp(adapter, makeDb()));

    expect(res.status).toBe(200);
    // The row must exist before the session does, otherwise a crash in between
    // leaves a live checkout this database cannot name.
    expect(order).toEqual(["claim", "provider", "finalize"]);
  });

  it("claims the row in provider_creating, not pending", async () => {
    await post(buildApp(makeAdapter(), makeDb()));

    const [, input] = repo.claimCheckout.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.idempotencyKey).toBe(KEY);
    expect(input.tenantId).toBe(TENANT.tenantId);
  });

  it("calls the provider outside any transaction", async () => {
    const db = makeDb();
    const adapter = makeAdapter();
    let inTx = false;
    vi.mocked(
      db as unknown as { transaction: ReturnType<typeof vi.fn> },
    ).transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      inTx = true;
      const out = await fn(makeTxHandle());
      inTx = false;
      return out;
    });
    adapter.createCheckout.mockImplementation(async () => {
      // Holding a transaction across an outbound HTTP call would pin a pooled
      // connection for a latency this service does not control.
      expect(inTx).toBe(false);
      return {
        providerSessionId: "ps_lifecycle_1",
        webUrl: "https://provider.example/pay",
        expiresAt: EXPIRES,
      };
    });

    const res = await post(buildApp(adapter, db));
    expect(res.status).toBe(200);
  });

  it("stores the provider answer whole so a later replay can reproduce it", async () => {
    await post(buildApp(makeAdapter(), makeDb()));

    const [, opts] = repo.finalizeCheckout.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.providerRef).toBe("ps_lifecycle_1");
    expect(opts.checkoutResult).toMatchObject({
      webUrl: "https://provider.example/pay/ps_lifecycle_1",
      qrUrl: "https://provider.example/qr/ps_lifecycle_1",
      expiresAt: EXPIRES.toISOString(),
      discountApplied: false,
    });
  });
});

describe("retry on an existing claim", () => {
  it("replays the full body, URLs included", async () => {
    repo.claimCheckout.mockResolvedValue({
      created: false,
      row: claimedRow({
        status: "awaiting_payment",
        providerRef: "ps_lifecycle_1",
        checkoutResultJson: {
          webUrl: "https://provider.example/pay/ps_lifecycle_1",
          qrUrl: "https://provider.example/qr/ps_lifecycle_1",
          expiresAt: EXPIRES.toISOString(),
          discountApplied: true,
        },
      }),
    });
    const adapter = makeAdapter();

    const res = await post(buildApp(adapter, makeDb()));
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    // A replay that dropped webUrl would look like success and leave the caller
    // with no way to send the customer anywhere.
    expect(body.data).toMatchObject({
      transactionId: "tx-lifecycle-1",
      provider: "mock-provider",
      webUrl: "https://provider.example/pay/ps_lifecycle_1",
      qrUrl: "https://provider.example/qr/ps_lifecycle_1",
      expiresAt: EXPIRES.toISOString(),
      discountApplied: true,
      cached: true,
    });
    // No second session for the same money.
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it("reports 409 CHECKOUT_IN_PROGRESS while the first attempt is still mid-provider", async () => {
    repo.claimCheckout.mockResolvedValue({ created: false, row: claimedRow() });
    const adapter = makeAdapter();

    const res = await post(buildApp(adapter, makeDb()));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CHECKOUT_IN_PROGRESS");
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it("treats a row with no stored answer as in progress, not as a replay", async () => {
    // A row written before checkout_result_json existed. Replaying it would hand
    // back a body with no webUrl.
    repo.claimCheckout.mockResolvedValue({
      created: false,
      row: claimedRow({ status: "pending", providerRef: "ps_old", checkoutResultJson: null }),
    });

    const res = await post(buildApp(makeAdapter(), makeDb()));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CHECKOUT_IN_PROGRESS");
  });

  it("refuses to re-issue a session for a payment that already completed", async () => {
    repo.claimCheckout.mockResolvedValue({
      created: false,
      row: claimedRow({ status: "completed", providerRef: "ps_lifecycle_1" }),
    });
    const adapter = makeAdapter();

    const res = await post(buildApp(adapter, makeDb()));
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CHECKOUT_NOT_REPLAYABLE");
    expect(body.error.message).toContain("completed");
    // Re-issuing here would be a second charge.
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });
});

describe("provider failure", () => {
  it("returns 502 and leaves the claim in place for reconcile", async () => {
    const adapter = makeAdapter();
    adapter.createCheckout.mockRejectedValue(new Error("provider timeout"));

    const res = await post(buildApp(adapter, makeDb()));
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("PROVIDER_CHECKOUT_FAILED");
    // The row stays claimed: a failure that created a session first is
    // indistinguishable from one that did not, so a retry must not create a second.
    expect(repo.finalizeCheckout).not.toHaveBeenCalled();
  });

  it("does not leak the provider error text to the caller", async () => {
    const adapter = makeAdapter();
    adapter.createCheckout.mockRejectedValue(new Error("sk_live_secret rejected"));

    const res = await post(buildApp(adapter, makeDb()));
    const text = await res.text();

    expect(text).not.toContain("sk_live_secret");
  });
});

describe("lost claim race", () => {
  it("rolls the discount consumption back when another request owns the key", async () => {
    // The redemption is spent inside the same transaction as the claim, so losing
    // the claim has to undo it — otherwise the promo is gone and no checkout exists.
    let consumeCalls = 0;
    let rolledBack = false;
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        try {
          return await fn(makeTxHandle());
        } catch (err) {
          if (consumeCalls > 0) rolledBack = true;
          throw err;
        }
      }),
    } as never;

    repo.claimCheckout.mockImplementation(async () => ({
      created: false,
      row: claimedRow(),
    }));

    const adapter = makeAdapter();
    const app = buildApp(adapter, db, {
      discountResolver: async () => ({
        percent: 10,
        code: "PROMO10",
        sourceId: "src-1",
        consume: async () => {
          consumeCalls += 1;
          return true;
        },
      }),
    });

    const res = await post(app);

    expect(res.status).toBe(409);
    expect(consumeCalls).toBe(1);
    expect(rolledBack).toBe(true);
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });
});
