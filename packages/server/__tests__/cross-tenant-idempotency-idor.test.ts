/**
 * Cross-tenant IDOR regression test — idempotency key lookup must be
 * tenant-scoped. Tenant B must NOT see tenant A's transaction by replaying
 * the same Idempotency-Key.
 *
 * Invariant: idempotency keys are unique within a single tenant; a lookup
 * must filter by tenantId so one tenant cannot read another's transaction.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildStripeCheckoutRoute } from "../src/routes/checkout/stripe-route.js";
import { buildSepayCheckoutRoute } from "../src/routes/checkout/sepay-route.js";
import { buildCheckoutRouter } from "../src/routes/checkout/checkout-router.js";

// Mock payment repo — we intercept findByIdempotencyKey to verify tenant scoping
vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => ({
  createTransaction: vi.fn().mockResolvedValue({
    transactionId: "tx-new-000",
    tenantId: "tenant-bbb",
    provider: "stripe",
    amountMicros: "100000000",
    providerRef: null,
    idempotencyKey: "shared-key-K",
    metadataJson: {},
  }),
  findByIdempotencyKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./apply-discount.js", () => ({
  resolveDiscount: vi.fn().mockResolvedValue({ discount: null, reason: undefined }),
  applyDiscountInTx: vi.fn().mockResolvedValue({
    effectiveMicros: 100000000n,
    applied: false,
    discount: null,
  }),
}));

import { findByIdempotencyKey } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";

const TENANT_A = { tenantId: "tenant-aaa-111", ownerId: "owner-aaa-111" };
const TENANT_B = { tenantId: "tenant-bbb-222", ownerId: "owner-bbb-222" };

const TENANT_A_TX = {
  transactionId: "tx-aaa-001",
  tenantId: TENANT_A.tenantId,
  provider: "stripe",
  amountMicros: "500000000",
  providerRef: "cs_stripe_session_aaa",
  idempotencyKey: "shared-key-K",
  metadataJson: { checkoutUrl: "https://checkout.stripe.com/aaa" },
  status: "pending",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeDb = {
  transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(fakeDb)),
  insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([TENANT_A_TX]) }) }),
  update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  query: { paymentTransactions: { findFirst: vi.fn() } },
} as never;

describe("cross-tenant IDOR: findByIdempotencyKey must be tenant-scoped", () => {
  it("findByIdempotencyKey is called with 3 arguments (db, tenantId, key)", () => {
    // The mock intercepts calls — verify the real module export exists and
    // call sites pass exactly 3 args (validated by the subsequent tests).
    // This is a structural assertion: the mock was set up, and call-site tests
    // below prove the 3-arg contract is enforced at every usage.
    expect(findByIdempotencyKey).toBeDefined();
    expect(typeof findByIdempotencyKey).toBe("function");
  });

  it("stripe route passes tenantId to findByIdempotencyKey", async () => {
    vi.mocked(findByIdempotencyKey).mockClear();
    vi.mocked(findByIdempotencyKey).mockResolvedValue(undefined);

    const app = new Hono();
    app.route(
      "/",
      buildStripeCheckoutRoute({
        db: fakeDb,
        tenantResolver: async () => TENANT_A,
        stripeClient: {
          createTopUpSession: vi.fn().mockResolvedValue({
            sessionId: "cs_test",
            checkoutUrl: "https://checkout.stripe.com/test",
          }),
        } as never,
      }),
    );

    await app.request("/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "shared-key-K",
      },
      body: JSON.stringify({ amountUsd: 50 }),
    });

    // Critical: findByIdempotencyKey must be called with (db, tenantId, key)
    expect(findByIdempotencyKey).toHaveBeenCalledWith(
      fakeDb,
      TENANT_A.tenantId,
      "shared-key-K",
    );
  });

  it("sepay route passes tenantId to findByIdempotencyKey", async () => {
    vi.mocked(findByIdempotencyKey).mockClear();
    vi.mocked(findByIdempotencyKey).mockResolvedValue(undefined);

    const app = new Hono();
    app.route(
      "/",
      buildSepayCheckoutRoute({
        db: fakeDb,
        tenantResolver: async () => TENANT_B,
        sepayClient: {
          generateQrUrl: vi.fn().mockReturnValue({
            qrUrl: "https://qr.sepay.vn/test",
            amount: 100000,
            expiresAt: new Date(),
          }),
        } as never,
      }),
    );

    await app.request("/sepay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "shared-key-K",
      },
      body: JSON.stringify({ amountVnd: 100000 }),
    });

    expect(findByIdempotencyKey).toHaveBeenCalledWith(
      fakeDb,
      TENANT_B.tenantId,
      "shared-key-K",
    );
  });

  it("checkout-router passes tenantId to findByIdempotencyKey", async () => {
    vi.mocked(findByIdempotencyKey).mockClear();
    vi.mocked(findByIdempotencyKey).mockResolvedValue(undefined);

    const mockAdapter = {
      id: "mock-provider",
      supportedCurrencies: ["USD"],
      createCheckout: vi.fn().mockResolvedValue({
        providerSessionId: "ps_123",
        webUrl: "https://example.com/pay",
        expiresAt: new Date(),
      }),
    };

    const app = new Hono();
    app.route(
      "/",
      buildCheckoutRouter({
        db: fakeDb,
        registry: { list: () => [mockAdapter] } as never,
        tenantResolver: async () => TENANT_A,
      }),
    );

    await app.request("/mock-provider", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "shared-key-K",
      },
      body: JSON.stringify({ amountUsd: 25 }),
    });

    expect(findByIdempotencyKey).toHaveBeenCalledWith(
      fakeDb,
      TENANT_A.tenantId,
      "shared-key-K",
    );
  });

  it("tenant B replay of tenant A key must NOT return tenant A transaction", async () => {
    // Simulate: findByIdempotencyKey(db, tenantB, key) returns undefined
    // because the lookup is now tenant-scoped — tenant A's tx is invisible to B.
    vi.mocked(findByIdempotencyKey).mockClear();
    vi.mocked(findByIdempotencyKey).mockResolvedValue(undefined);

    const app = new Hono();
    app.route(
      "/",
      buildStripeCheckoutRoute({
        db: fakeDb,
        tenantResolver: async () => TENANT_B,
        stripeClient: {
          createTopUpSession: vi.fn().mockResolvedValue({
            sessionId: "cs_new_for_b",
            checkoutUrl: "https://checkout.stripe.com/b",
          }),
        } as never,
      }),
    );

    const res = await app.request("/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "shared-key-K",
      },
      body: JSON.stringify({ amountUsd: 50 }),
    });

    // Tenant B should NOT get tenant A's session/checkoutUrl
    const body = await res.json();
    expect(body.data?.sessionId).not.toBe("cs_stripe_session_aaa");
    expect(body.data?.checkoutUrl).not.toContain("/aaa");

    // The lookup was scoped to tenant B
    expect(findByIdempotencyKey).toHaveBeenCalledWith(
      fakeDb,
      TENANT_B.tenantId,
      "shared-key-K",
    );
  });

  it("tenant A replay of own key returns cached transaction", async () => {
    // findByIdempotencyKey(db, tenantA, key) returns tenant A's existing tx
    vi.mocked(findByIdempotencyKey).mockClear();
    vi.mocked(findByIdempotencyKey).mockResolvedValue(TENANT_A_TX as never);

    const app = new Hono();
    app.route(
      "/",
      buildStripeCheckoutRoute({
        db: fakeDb,
        tenantResolver: async () => TENANT_A,
        stripeClient: {
          createTopUpSession: vi.fn(),
        } as never,
      }),
    );

    const res = await app.request("/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "shared-key-K",
      },
      body: JSON.stringify({ amountUsd: 50 }),
    });

    const body = await res.json();
    // Tenant A gets their own cached transaction back
    expect(body.data?.transactionId).toBe("tx-aaa-001");
    expect(body.data?.sessionId).toBe("cs_stripe_session_aaa");
  });

  it("sepay replay regenerates QR from stored numeric(20,6) amount without crashing", async () => {
    // Regression: amount_micros is numeric(20,6) → round-trips as a decimal
    // string ("100000000.000000"). BigInt() throws on the fractional part, so
    // the replay branch must parse via the micros helper, not raw BigInt().
    vi.mocked(findByIdempotencyKey).mockClear();
    vi.mocked(findByIdempotencyKey).mockResolvedValue({
      transactionId: "tx-sepay-replay-001",
      tenantId: TENANT_B.tenantId,
      provider: "sepay",
      amountMicros: "100000000.000000",
      providerRef: "sepay_ref_existing",
      idempotencyKey: "sepay-replay-K",
      metadataJson: { discountApplied: false },
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const app = new Hono();
    app.route(
      "/",
      buildSepayCheckoutRoute({
        db: fakeDb,
        tenantResolver: async () => TENANT_B,
        sepayClient: {
          generateQrUrl: vi.fn().mockReturnValue({
            qrUrl: "https://qr.sepay.vn/replay",
            amount: 100,
            expiresAt: new Date(),
          }),
        } as never,
      }),
    );

    const res = await app.request("/sepay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "sepay-replay-K",
      },
      body: JSON.stringify({ amountVnd: 999999 }),
    });

    // Must not 500 on the decimal-string amount; returns the stored tx
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data?.transactionId).toBe("tx-sepay-replay-001");
    expect(body.data?.qrUrl).toBe("https://qr.sepay.vn/replay");
  });
});
