import type { PaykitAuthContext } from "@xeko-git-1/paykit-server";
/**
 * Rate-limit tests — verifies the durable fixed-window path (Postgres-backed,
 * exact across instances), the in-memory fallback, X-RateLimit-* headers, and
 * isolation between different keys.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitMiddleware, resetAllBuckets } from "../src/v1/rate-limit.js";
import { buildV1TestApp } from "./helpers/build-v1-test-app.js";

describe("/v1 rate limiting", () => {
  beforeEach(() => {
    resetAllBuckets();
  });

  const authMerchantA: PaykitAuthContext = {
    merchantId: "merchant-A",
    tenant: { tenantId: "merchant-A", ownerId: "merchant-A" },
    scopes: ["balance:read"],
    plane: "api_key",
  };

  const authMerchantB: PaykitAuthContext = {
    merchantId: "merchant-B",
    tenant: { tenantId: "merchant-B", ownerId: "merchant-B" },
    scopes: ["balance:read"],
    plane: "api_key",
  };

  it("N requests succeed, N+1 returns 429 with X-RateLimit-* headers", async () => {
    // Use a low limit for testing
    const { app } = buildV1TestApp({ auth: authMerchantA });

    // The default rate limit is 100 — send 100 requests
    let lastRes: Response | null = null;
    for (let i = 0; i < 100; i++) {
      lastRes = await app.request(new Request("http://localhost/v1/balances"));
      expect(lastRes.status).toBe(200);
    }

    // Verify rate-limit headers on successful response
    expect(lastRes!.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(lastRes!.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(lastRes!.headers.get("X-RateLimit-Reset")).toBeDefined();

    // 101st request should be rate-limited
    const blockedRes = await app.request(new Request("http://localhost/v1/balances"));
    expect(blockedRes.status).toBe(429);
    const body = await blockedRes.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(blockedRes.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("rate-limit is isolated per key_id (merchant)", async () => {
    // Exhaust merchant A's bucket
    const { app: appA } = buildV1TestApp({ auth: authMerchantA });
    for (let i = 0; i < 100; i++) {
      await appA.request(new Request("http://localhost/v1/balances"));
    }
    const blockedA = await appA.request(new Request("http://localhost/v1/balances"));
    expect(blockedA.status).toBe(429);

    // Merchant B should still have full quota
    const { app: appB } = buildV1TestApp({ auth: authMerchantB });
    const resB = await appB.request(new Request("http://localhost/v1/balances"));
    expect(resB.status).toBe(200);
    expect(resB.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("X-RateLimit-Limit header is present on all responses", async () => {
    const { app } = buildV1TestApp({ auth: authMerchantA });
    const res = await app.request(new Request("http://localhost/v1/balances"));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
  });

  it("two keys of the SAME merchant get independent buckets (per-keyId)", async () => {
    const keyOne: PaykitAuthContext = { ...authMerchantA, keyId: "key-1" };
    const keyTwo: PaykitAuthContext = { ...authMerchantA, keyId: "key-2" };

    // Exhaust key-1's bucket
    const { app: appKey1 } = buildV1TestApp({ auth: keyOne });
    for (let i = 0; i < 100; i++) {
      await appKey1.request(new Request("http://localhost/v1/balances"));
    }
    const blocked1 = await appKey1.request(new Request("http://localhost/v1/balances"));
    expect(blocked1.status).toBe(429);

    // key-2 (same merchant) must still have its full quota
    const { app: appKey2 } = buildV1TestApp({ auth: keyTwo });
    const resKey2 = await appKey2.request(new Request("http://localhost/v1/balances"));
    expect(resKey2.status).toBe(200);
    expect(resKey2.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("falls back to merchant bucket when keyId is absent (jwt plane)", async () => {
    const jwtAuth: PaykitAuthContext = {
      merchantId: "merchant-C",
      tenant: { tenantId: "merchant-C", ownerId: "merchant-C" },
      scopes: ["balance:read"],
      plane: "jwt",
    };
    const { app } = buildV1TestApp({ auth: jwtAuth });
    const res = await app.request(new Request("http://localhost/v1/balances"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("counts in the durable store (rate_limit_windows), not in process memory", async () => {
    // Two requests through the same app must both land in the mock db's
    // fixed-window counter — the property the durable path exists for.
    const { app, dbState } = buildV1TestApp({ auth: { ...authMerchantA, keyId: "key-d" } });
    await app.request(new Request("http://localhost/v1/balances"));
    await app.request(new Request("http://localhost/v1/balances"));

    const window = dbState.rateLimits.get("key-d");
    expect(window).toBeDefined();
    expect(window?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Middleware-level behaviors the shared app helper cannot express
// ---------------------------------------------------------------------------

const AUTH: PaykitAuthContext = {
  merchantId: "merchant-X",
  tenant: { tenantId: "merchant-X", ownerId: "merchant-X" },
  scopes: ["balance:read"],
  plane: "api_key",
  keyId: "key-x",
};

function buildBareApp(middleware: ReturnType<typeof rateLimitMiddleware>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("paykitAuth", AUTH);
    await next();
  });
  app.use("*", middleware);
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("durable rate limit — window rollover and fallback", () => {
  beforeEach(() => {
    resetAllBuckets();
  });

  it("resets the count when the window rolls over", async () => {
    // A stateful fake of the repo's UPSERT: same window increments, new resets.
    const windows = new Map<string, { ws: number; count: number }>();
    const db = {
      insert: () => ({
        values: (data: { bucketKey: string; windowStart: Date }) => ({
          onConflictDoUpdate: () => ({
            returning: () => {
              const ws = data.windowStart.getTime();
              const prev = windows.get(data.bucketKey);
              const count = prev !== undefined && prev.ws === ws ? prev.count + 1 : 1;
              windows.set(data.bucketKey, { ws, count });
              return Promise.resolve([{ requestCount: count }]);
            },
          }),
        }),
      }),
    } as never;

    // Deterministic clock: exhaust the budget inside one window, step the
    // clock into the next window, and get let back in.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
      const app = buildBareApp(rateLimitMiddleware({ db, maxTokens: 2, refillIntervalMs: 25 }));
      expect((await app.request("/ping")).status).toBe(200);
      expect((await app.request("/ping")).status).toBe(200);
      expect((await app.request("/ping")).status).toBe(429);

      vi.setSystemTime(new Date("2026-08-13T00:00:00.030Z"));
      expect((await app.request("/ping")).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades to the in-memory bucket when the database errors — never an outage", async () => {
    const db = {
      insert: () => {
        throw new Error("connection refused");
      },
    } as never;
    const warn = vi.fn();

    const app = buildBareApp(rateLimitMiddleware({ db, maxTokens: 2, logger: { warn } }));
    expect((await app.request("/ping")).status).toBe(200);
    expect((await app.request("/ping")).status).toBe(200);
    // The in-memory budget still applies — degraded, not disabled.
    expect((await app.request("/ping")).status).toBe(429);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a hammering client saturated: rejected requests also count", async () => {
    const windows = new Map<string, { ws: number; count: number }>();
    const db = {
      insert: () => ({
        values: (data: { bucketKey: string; windowStart: Date }) => ({
          onConflictDoUpdate: () => ({
            returning: () => {
              const ws = data.windowStart.getTime();
              const prev = windows.get(data.bucketKey);
              const count = prev !== undefined && prev.ws === ws ? prev.count + 1 : 1;
              windows.set(data.bucketKey, { ws, count });
              return Promise.resolve([{ requestCount: count }]);
            },
          }),
        }),
      }),
    } as never;

    const app = buildBareApp(rateLimitMiddleware({ db, maxTokens: 1, refillIntervalMs: 60_000 }));
    await app.request("/ping");
    await app.request("/ping"); // rejected — still counted
    expect(windows.get("key-x")?.count).toBe(2);
  });
});
