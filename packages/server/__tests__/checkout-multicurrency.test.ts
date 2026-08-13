/**
 * Multi-currency checkout through the embedded router.
 *
 * The dispatch used to be a hardcoded USD/VND if-chain; it is now the shared
 * decision table plus the tenant's stored default. What has to hold:
 *
 *   - The legacy fields keep working bit-for-bit (regression guard).
 *   - A generic `amount` + `currency` charges in that currency, converted by
 *     the registry (integer yen, whole cents).
 *   - The tenant preference is consulted ONLY when it can matter — a generic
 *     amount with no explicit currency — so USD/VND traffic pays nothing new.
 *   - A currency the adapter does not support is refused before any claim or
 *     provider call: the wrong-currency wallet credit is the money bug this
 *     validation exists to prevent.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  claimCheckout: vi.fn(),
  finalizeCheckout: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js", () => repo);

const prefRepo = vi.hoisted(() => ({
  findByTenantId: vi.fn(),
  upsertPreference: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/tenant-currency.repo.js", () => prefRepo);

import { buildCheckoutRouter } from "../src/routes/checkout/checkout-router.js";

const TENANT = { tenantId: "tenant-mc-1", ownerId: "owner-mc-1" };
const EXPIRES = new Date("2026-01-01T00:00:00.000Z");

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "tx-mc-1",
    tenantId: TENANT.tenantId,
    provider: "mock-provider",
    amountMicros: "1000000000",
    currencyCode: "JPY",
    status: "provider_creating",
    providerRef: null,
    idempotencyKey: null,
    checkoutResultJson: null,
    metadataJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDb() {
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  } as never;
}

function makeAdapter(currencies: string[]) {
  return {
    id: "mock-provider",
    supportedCurrencies: currencies,
    createCheckout: vi.fn().mockResolvedValue({
      providerSessionId: "ps_mc_1",
      webUrl: "https://provider.example/pay/ps_mc_1",
      expiresAt: EXPIRES,
    }),
  };
}

function buildApp(adapter: ReturnType<typeof makeAdapter>) {
  const app = new Hono();
  app.route(
    "/",
    buildCheckoutRouter({
      db: makeDb(),
      registry: { list: () => [adapter] } as never,
      tenantResolver: async () => TENANT,
    }),
  );
  return app;
}

function post(app: Hono, body: Record<string, unknown>) {
  return app.request("/mock-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.claimCheckout.mockResolvedValue({ row: claimedRow(), created: true });
  repo.finalizeCheckout.mockResolvedValue(claimedRow({ status: "awaiting_payment" }));
  prefRepo.findByTenantId.mockResolvedValue(null);
});

describe("generic amount + explicit currency", () => {
  it("charges integer yen through a JPY adapter", async () => {
    const app = buildApp(makeAdapter(["JPY"]));
    const res = await post(app, { amount: 1000, currency: "JPY" });
    expect(res.status).toBe(200);
    const claim = repo.claimCheckout.mock.calls[0]?.[1];
    expect(claim.currencyCode).toBe("JPY");
    expect(claim.amountMicros).toBe((1000n * 1_000_000n).toString());
  });

  it("does not consult the preference when the currency is explicit", async () => {
    const app = buildApp(makeAdapter(["JPY"]));
    await post(app, { amount: 1000, currency: "JPY" });
    expect(prefRepo.findByTenantId).not.toHaveBeenCalled();
  });

  it("refuses a fractional yen as a 400, before any claim", async () => {
    const app = buildApp(makeAdapter(["JPY"]));
    const res = await post(app, { amount: 100.5, currency: "JPY" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(repo.claimCheckout).not.toHaveBeenCalled();
  });

  it("refuses a currency the adapter does not support, before any claim", async () => {
    const app = buildApp(makeAdapter(["USD"]));
    const res = await post(app, { amount: 1000, currency: "JPY" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("UNSUPPORTED_CURRENCY");
    expect(repo.claimCheckout).not.toHaveBeenCalled();
  });
});

describe("tenant preference as the default currency", () => {
  it("resolves a bare amount through the stored preference", async () => {
    prefRepo.findByTenantId.mockResolvedValue({
      tenantId: TENANT.tenantId,
      currencyCode: "EUR",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(makeAdapter(["USD", "EUR"]));
    const res = await post(app, { amount: 49.99 });
    expect(res.status).toBe(200);
    expect(prefRepo.findByTenantId).toHaveBeenCalledWith(expect.anything(), TENANT.tenantId);
    const claim = repo.claimCheckout.mock.calls[0]?.[1];
    expect(claim.currencyCode).toBe("EUR");
    expect(claim.amountMicros).toBe(49_990_000n.toString());
  });

  it("falls back to the adapter's native currency when no preference exists", async () => {
    const app = buildApp(makeAdapter(["USD"]));
    const res = await post(app, { amount: 25 });
    expect(res.status).toBe(200);
    const claim = repo.claimCheckout.mock.calls[0]?.[1];
    expect(claim.currencyCode).toBe("USD");
    expect(claim.amountMicros).toBe(25_000_000n.toString());
  });

  it("a preference the adapter cannot serve is refused, not silently swapped", async () => {
    prefRepo.findByTenantId.mockResolvedValue({
      tenantId: TENANT.tenantId,
      currencyCode: "EUR",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(makeAdapter(["USD"]));
    const res = await post(app, { amount: 25 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("UNSUPPORTED_CURRENCY");
  });
});

describe("legacy fields — regression guard", () => {
  it("amountUsd still works and never touches the preference", async () => {
    const app = buildApp(makeAdapter(["USD"]));
    const res = await post(app, { amountUsd: 25 });
    expect(res.status).toBe(200);
    expect(prefRepo.findByTenantId).not.toHaveBeenCalled();
    const claim = repo.claimCheckout.mock.calls[0]?.[1];
    expect(claim.currencyCode).toBe("USD");
    expect(claim.amountMicros).toBe(25_000_000n.toString());
  });

  it("amountVnd still works", async () => {
    const app = buildApp(makeAdapter(["VND"]));
    const res = await post(app, { amountVnd: 250_000 });
    expect(res.status).toBe(200);
    const claim = repo.claimCheckout.mock.calls[0]?.[1];
    expect(claim.currencyCode).toBe("VND");
    expect(claim.amountMicros).toBe((250_000n * 1_000_000n).toString());
  });

  it("mixing the styles is a 400, not a silent pick", async () => {
    const app = buildApp(makeAdapter(["USD"]));
    const res = await post(app, { amount: 50, amountUsd: 25 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/not both/);
    expect(repo.claimCheckout).not.toHaveBeenCalled();
  });
});
