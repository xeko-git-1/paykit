/**
 * Discount checkout integration test — drives the real buildV1Router and
 * proves a valid promo code reduces the CHARGED amount end-to-end (lookup →
 * race-safe consume inside the checkout transaction → reduced amountMicros
 * persisted), and that an unknown/inactive code falls back to full price.
 *
 * Uses a purpose-built table-aware db mock (the shared helper's mock is not
 * table-routed) so the discount SELECT, the redeem UPDATE, and the tx INSERT
 * each return the right shape.
 */
import type { PaymentProviderAdapter, ProviderRegistry } from "@vibecc/paykit";
import type { PaykitAuthContext } from "@vibecc/paykit-server";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { buildV1Router } from "../src/v1/router.js";
import { resetAllBuckets } from "../src/v1/rate-limit.js";

const AUTH: PaykitAuthContext = {
  merchantId: "merchant-1",
  tenant: { tenantId: "merchant-1", ownerId: "merchant-1" },
  scopes: ["checkout:write"],
  plane: "api_key",
  keyId: "key-1",
};

const DISCOUNT_ROW = {
  discountId: "disc-1",
  tenantId: "merchant-1",
  code: "SAVE25",
  percent: "25.00",
  maxRedemptions: 100,
  timesRedeemed: 0,
  active: true,
  expiresAt: null as Date | null,
};

// Capture what createTransaction was asked to persist.
let lastInsertedAmount: string | null = null;
let redeemReturns: unknown[] = [{ discountId: "disc-1" }];
let discountLookupRow: unknown = DISCOUNT_ROW;

function makeDb() {
  const insertChain = {
    values: (vals: Record<string, unknown>) => ({
      returning: async () => {
        lastInsertedAmount = (vals.amountMicros as string) ?? null;
        return [
          {
            transactionId: "tx-1",
            tenantId: vals.tenantId,
            ownerId: vals.ownerId,
            provider: vals.provider,
            amountMicros: vals.amountMicros,
            currencyCode: vals.currencyCode,
            status: "pending",
            providerRef: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            idempotencyKey: null,
            metadataJson: {},
          },
        ];
      },
    }),
  };

  const db = {
    // discount lookup
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (discountLookupRow ? [discountLookupRow] : []) }),
      }),
    }),
    insert: () => insertChain,
    // both redeem (returning) and providerRef update (awaited, no returning)
    update: () => ({
      set: () => ({
        where: () => {
          const chain: Record<string, unknown> = {
            returning: async () => redeemReturns,
            then: (resolve: (v: unknown) => void) => resolve(undefined),
          };
          return chain;
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db as never;
}

function makeApp() {
  const adapter: PaymentProviderAdapter = {
    id: "sepay",
    displayName: "SePay",
    supportedCurrencies: ["VND"],
    checkoutMode: "qr",
    createCheckout: async () => ({
      providerSessionId: "sess-1",
      webUrl: "https://pay.example/sess-1",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    verifyWebhookSignature: () => true,
    parseWebhookPayload: () => null,
    refund: async () => ({ state: "unsupported", reason: "x" }),
    fetchTransactions: async () => [],
  } as PaymentProviderAdapter;
  const registry = {
    get: (id: string) => (id === "sepay" ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("paykitAuth", AUTH);
    await next();
  });
  app.route("/v1", buildV1Router({ db: makeDb(), registry }));
  return app;
}

function checkout(body: Record<string, unknown>) {
  return new Request("http://localhost/v1/checkouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "sepay", amountVnd: 100_000, ...body }),
  });
}

beforeEach(() => {
  resetAllBuckets();
  lastInsertedAmount = null;
  redeemReturns = [{ discountId: "disc-1" }];
  discountLookupRow = DISCOUNT_ROW;
});

describe("POST /v1/checkouts discount application", () => {
  it("applies a valid 25% code: charged amount reduced, discountApplied=true", async () => {
    const res = await makeApp().request(checkout({ discountCode: "SAVE25" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.discountApplied).toBe(true);
    // 100_000 VND → 100_000 * 1_000_000 micros, 25% off → 75_000 * 1_000_000.
    expect(lastInsertedAmount).toBe((75_000n * 1_000_000n).toString());
  });

  it("charges full price when no code is supplied", async () => {
    const res = await makeApp().request(checkout({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.discountApplied).toBe(false);
    expect(lastInsertedAmount).toBe((100_000n * 1_000_000n).toString());
  });

  it("falls back to full price when the code is unknown/inactive", async () => {
    discountLookupRow = null; // findActiveByCode returns undefined
    const res = await makeApp().request(checkout({ discountCode: "NOPE" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.discountApplied).toBe(false);
    expect(lastInsertedAmount).toBe((100_000n * 1_000_000n).toString());
  });

  it("falls back to full price when the redemption race is lost (cap reached)", async () => {
    redeemReturns = []; // redeem() → false
    const res = await makeApp().request(checkout({ discountCode: "SAVE25" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.discountApplied).toBe(false);
    expect(lastInsertedAmount).toBe((100_000n * 1_000_000n).toString());
  });
});
