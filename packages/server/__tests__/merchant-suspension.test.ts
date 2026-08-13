/**
 * Merchant suspension enforcement — both auth planes.
 *
 * The suspension lives on `merchants.status`, not on the credentials: the api
 * keys stay valid (revoking them would destroy state the operator wants back
 * on reactivation) and JWTs cannot be revoked at all. So the status check in
 * the auth middleware is the ONLY enforcement point, and it must hold on both
 * planes or a suspended merchant simply switches token type.
 *
 * The answer is 403, not 401 — the identity is proven, the account is denied —
 * so client tooling reports the real reason instead of retrying credentials.
 */
import { mintApiKey } from "@xeko-git-1/paykit-auth-core/auth/api-key.js";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { describe, expect, it, vi } from "vitest";
import { type ApiKeyAuthDeps, apiKeyAuthMiddleware } from "../src/auth/api-key-middleware.js";
import { type JwtAuthDeps, jwtAuthMiddleware } from "../src/auth/jwt-middleware.js";

const TEST_SECRET = "a-very-long-secret-that-is-at-least-32-bytes-long-for-testing";
const TEST_ISSUER = "paykit";
const TEST_AUDIENCE = "paykit-dashboard";
const MERCHANT_ID = "merchant-uuid-123";
const TENANT = { tenantId: MERCHANT_ID, ownerId: MERCHANT_ID };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiKeyApp(overrides: Partial<ApiKeyAuthDeps> = {}) {
  const minted = mintApiKey({
    merchantId: MERCHANT_ID,
    mode: "live",
    scopes: ["checkout:write"],
  });
  const deps: ApiKeyAuthDeps = {
    db: {} as never,
    findByHash: vi.fn().mockResolvedValue({
      keyId: "key-1",
      merchantId: MERCHANT_ID,
      keyHash: minted.keyHash,
      keyPrefix: minted.keyPrefix,
      mode: "live",
      scopes: ["checkout:write"],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    resolveMerchantTenant: vi.fn().mockResolvedValue(TENANT),
    ...overrides,
  };
  const app = new Hono();
  app.use("*", apiKeyAuthMiddleware(deps));
  app.get("/test", (c) => c.json({ ok: true }));
  return { app, plaintext: minted.plaintext, deps };
}

async function makeJwtToken(): Promise<string> {
  return sign(
    {
      sub: MERCHANT_ID,
      tenant_id: TENANT.tenantId,
      owner_id: TENANT.ownerId,
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      scopes: ["balance:read"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    TEST_SECRET,
    "HS256",
  );
}

function buildJwtApp(overrides: Partial<JwtAuthDeps> = {}) {
  const deps: JwtAuthDeps = {
    loadSecret: vi.fn().mockResolvedValue(TEST_SECRET),
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    ...overrides,
  };
  const app = new Hono();
  app.use("*", jwtAuthMiddleware(deps));
  app.get("/test", (c) => c.json({ ok: true }));
  return { app, deps };
}

// ---------------------------------------------------------------------------
// api_key plane
// ---------------------------------------------------------------------------

describe("merchant suspension — api_key plane", () => {
  it("returns 403 MERCHANT_SUSPENDED for a valid key of a suspended merchant", async () => {
    const loadMerchantStatus = vi.fn().mockResolvedValue("suspended");
    const { app, plaintext } = buildApiKeyApp({ loadMerchantStatus });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("MERCHANT_SUSPENDED");
    expect(loadMerchantStatus).toHaveBeenCalledWith(expect.anything(), MERCHANT_ID);
  });

  it("passes an active merchant through", async () => {
    const { app, plaintext } = buildApiKeyApp({
      loadMerchantStatus: vi.fn().mockResolvedValue("active"),
    });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });

  it("passes when the merchant row does not exist (null status)", async () => {
    // Absence of lifecycle management is not suspension — embedded consumers
    // may not use the merchants table at all.
    const { app, plaintext } = buildApiKeyApp({
      loadMerchantStatus: vi.fn().mockResolvedValue(null),
    });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });

  it("does not run the status check when the dep is omitted (back-compat)", async () => {
    const { app, plaintext } = buildApiKeyApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });

  it("checks the status only AFTER the key itself verified", async () => {
    // An attacker with an invalid key must not learn whether a merchant is
    // suspended: bad key → 401, regardless of status.
    const loadMerchantStatus = vi.fn().mockResolvedValue("suspended");
    const { app } = buildApiKeyApp({
      findByHash: vi.fn().mockResolvedValue(null),
      loadMerchantStatus,
    });
    const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: [] });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });
    expect(res.status).toBe(401);
    expect(loadMerchantStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// jwt plane
// ---------------------------------------------------------------------------

describe("merchant suspension — jwt plane", () => {
  it("returns 403 MERCHANT_SUSPENDED for a valid token of a suspended merchant", async () => {
    const loadMerchantStatus = vi.fn().mockResolvedValue("suspended");
    const { app } = buildJwtApp({ loadMerchantStatus });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${await makeJwtToken()}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("MERCHANT_SUSPENDED");
    expect(loadMerchantStatus).toHaveBeenCalledWith(MERCHANT_ID);
  });

  it("passes an active merchant through", async () => {
    const { app } = buildJwtApp({
      loadMerchantStatus: vi.fn().mockResolvedValue("active"),
    });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${await makeJwtToken()}` },
    });
    expect(res.status).toBe(200);
  });

  it("passes when the merchant row does not exist (null status)", async () => {
    const { app } = buildJwtApp({
      loadMerchantStatus: vi.fn().mockResolvedValue(null),
    });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${await makeJwtToken()}` },
    });
    expect(res.status).toBe(200);
  });

  it("does not run the status check when the dep is omitted (back-compat)", async () => {
    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${await makeJwtToken()}` },
    });
    expect(res.status).toBe(200);
  });

  it("checks the status only AFTER signature verification", async () => {
    // A forged token must not trigger merchant lookups: bad signature → 401,
    // and the status loader is never consulted.
    const loadMerchantStatus = vi.fn().mockResolvedValue("suspended");
    const { app } = buildJwtApp({ loadMerchantStatus });
    const forged = await sign(
      {
        sub: MERCHANT_ID,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "the-wrong-secret-which-is-also-32-bytes-long!!",
      "HS256",
    );
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    expect(loadMerchantStatus).not.toHaveBeenCalled();
  });
});
