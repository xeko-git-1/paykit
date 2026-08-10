/**
 * Rate-limit tests — verifies per-key token bucket behavior,
 * X-RateLimit-* headers, and isolation between different keys.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { buildV1TestApp } from "./helpers/build-v1-test-app.js";
import { resetAllBuckets } from "../src/v1/rate-limit.js";
import type { PaykitAuthContext } from "@xeko-git-1/paykit-server";

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
});
