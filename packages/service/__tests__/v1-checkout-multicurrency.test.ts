/**
 * Multi-currency checkout through /v1 — the generic `amount` + `currency`
 * request style next to the legacy amountUsd/amountVnd fields.
 *
 * The boundary asserted here is the adapter call: whatever the request named,
 * the adapter must receive the resolved currency and the registry-converted
 * micros, because that pair is what the provider charges and what the wallet
 * is keyed by. The decision table itself is unit-tested in core; these tests
 * pin the /v1 wiring — DTO acceptance, tenant-preference lookup through the
 * db, and the 400s arriving before any provider call.
 */
import type { PaymentProviderAdapter } from "@xeko-git-1/paykit";
import type { PaykitAuthContext } from "@xeko-git-1/paykit-server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildV1TestApp, createMockDbState } from "./helpers/build-v1-test-app.js";

const auth: PaykitAuthContext = {
  merchantId: "merchant-mc",
  tenant: { tenantId: "merchant-mc", ownerId: "merchant-mc" },
  scopes: ["checkout:write"],
  plane: "api_key",
};

function makeAdapter(id: string, currencies: string[]) {
  const createCheckout = vi.fn().mockResolvedValue({
    providerSessionId: "sess-mc-1",
    webUrl: "https://pay.example.com/session/mc-1",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const adapter = {
    id,
    supportedCurrencies: currencies,
    checkoutMode: "redirect" as const,
    createCheckout,
    parseWebhookPayload: async () => null,
    verifyWebhookSignature: async () => true,
    refund: async () => ({ state: "completed" as const, providerRefundId: "ref-mc" }),
    fetchTransactions: async () => [],
  } as unknown as PaymentProviderAdapter;
  return { adapter, createCheckout };
}

function postCheckout(
  app: { request: (req: Request) => Promise<Response> },
  body: Record<string, unknown>,
) {
  return app.request(
    new Request("http://localhost/v1/checkouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/checkouts — generic amount + currency", () => {
  it("charges integer yen through a JPY provider", async () => {
    const { adapter, createCheckout } = makeAdapter("jpy-pay", ["JPY"]);
    const { app } = buildV1TestApp({ auth, adapters: [adapter] });

    const res = await postCheckout(app, { provider: "jpy-pay", amount: 1000, currency: "JPY" });
    expect(res.status).toBe(200);
    expect(createCheckout).toHaveBeenCalledTimes(1);
    const call = createCheckout.mock.calls[0]?.[0];
    expect(call.currencyCode).toBe("JPY");
    expect(call.amountMicros).toBe(1000n * 1_000_000n);
  });

  it("resolves a bare amount through the tenant's stored preference", async () => {
    const { adapter, createCheckout } = makeAdapter("multi-pay", ["USD", "EUR"]);
    const dbState = createMockDbState();
    dbState.currencyPreferences.push({
      tenantId: auth.tenant.tenantId,
      currencyCode: "EUR",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { app } = buildV1TestApp({ auth, adapters: [adapter], dbState });

    const res = await postCheckout(app, { provider: "multi-pay", amount: 49.99 });
    expect(res.status).toBe(200);
    const call = createCheckout.mock.calls[0]?.[0];
    expect(call.currencyCode).toBe("EUR");
    expect(call.amountMicros).toBe(49_990_000n);
  });

  it("refuses a currency the provider does not support before calling it", async () => {
    const { adapter, createCheckout } = makeAdapter("usd-pay", ["USD"]);
    const { app } = buildV1TestApp({ auth, adapters: [adapter] });

    const res = await postCheckout(app, { provider: "usd-pay", amount: 1000, currency: "JPY" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("UNSUPPORTED_CURRENCY");
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("refuses a fractional yen as a validation error", async () => {
    const { adapter, createCheckout } = makeAdapter("jpy-pay", ["JPY"]);
    const { app } = buildV1TestApp({ auth, adapters: [adapter] });

    const res = await postCheckout(app, { provider: "jpy-pay", amount: 100.5, currency: "JPY" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("refuses a body naming both request styles", async () => {
    const { adapter, createCheckout } = makeAdapter("usd-pay", ["USD"]);
    const { app } = buildV1TestApp({ auth, adapters: [adapter] });

    const res = await postCheckout(app, { provider: "usd-pay", amount: 50, amountUsd: 25 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/not both/);
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

describe("POST /v1/checkouts — legacy fields regression", () => {
  it("amountVnd still charges VND exactly as before", async () => {
    const { adapter, createCheckout } = makeAdapter("sepay", ["VND"]);
    const { app } = buildV1TestApp({ auth, adapters: [adapter] });

    const res = await postCheckout(app, { provider: "sepay", amountVnd: 250_000 });
    expect(res.status).toBe(200);
    const call = createCheckout.mock.calls[0]?.[0];
    expect(call.currencyCode).toBe("VND");
    expect(call.amountMicros).toBe(250_000n * 1_000_000n);
  });

  it("amountUsd still charges USD exactly as before", async () => {
    const { adapter, createCheckout } = makeAdapter("stripe", ["USD"]);
    const { app } = buildV1TestApp({ auth, adapters: [adapter] });

    const res = await postCheckout(app, { provider: "stripe", amountUsd: 25 });
    expect(res.status).toBe(200);
    const call = createCheckout.mock.calls[0]?.[0];
    expect(call.currencyCode).toBe("USD");
    expect(call.amountMicros).toBe(25_000_000n);
  });
});
