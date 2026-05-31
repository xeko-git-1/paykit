/**
 * Auth middleware tests — covers API-key middleware, JWT middleware,
 * plane separation, fail-closed behavior, and requireScope.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { apiKeyAuthMiddleware, type ApiKeyAuthDeps } from "../src/auth/api-key-middleware.js";
import { jwtAuthMiddleware, createJwtSecretLoader, type JwtAuthDeps } from "../src/auth/jwt-middleware.js";
import { requireScope, requirePlane } from "../src/auth/require-scope.js";
import { mintApiKey } from "../src/auth/api-key.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "a-very-long-secret-that-is-at-least-32-bytes-long-for-testing";
const TEST_ISSUER = "paykit";
const TEST_AUDIENCE = "paykit-dashboard";

const MERCHANT_ID = "merchant-uuid-123";
const TENANT = { tenantId: "tenant-uuid-456", ownerId: "owner-uuid-789" };

function makeApiKeyDeps(overrides: Partial<ApiKeyAuthDeps> = {}): ApiKeyAuthDeps {
  const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: ["checkout:write", "balance:read"] });
  return {
    db: {} as never,
    findByHash: vi.fn().mockResolvedValue({
      keyId: "key-1",
      merchantId: MERCHANT_ID,
      keyHash: minted.keyHash,
      keyPrefix: minted.keyPrefix,
      mode: "live",
      scopes: ["checkout:write", "balance:read"],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    resolveMerchantTenant: vi.fn().mockResolvedValue(TENANT),
    ...overrides,
  };
}

async function makeJwtToken(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
): Promise<string> {
  return sign(
    {
      sub: MERCHANT_ID,
      tenant_id: TENANT.tenantId,
      owner_id: TENANT.ownerId,
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      scopes: ["balance:read"],
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload,
    },
    secret,
    "HS256",
  );
}

function makeJwtDeps(overrides: Partial<JwtAuthDeps> = {}): JwtAuthDeps {
  return {
    loadSecret: vi.fn().mockResolvedValue(TEST_SECRET),
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    ...overrides,
  };
}

function buildApiKeyApp(deps?: Partial<ApiKeyAuthDeps>) {
  const app = new Hono();
  const fullDeps = makeApiKeyDeps(deps);
  app.use("*", apiKeyAuthMiddleware(fullDeps));
  app.get("/test", (c) => {
    const auth = c.get("paykitAuth");
    return c.json({ tenant: auth.tenant, plane: auth.plane });
  });
  return { app, deps: fullDeps };
}

function buildJwtApp(deps?: Partial<JwtAuthDeps>) {
  const app = new Hono();
  const fullDeps = makeJwtDeps(deps);
  app.use("*", jwtAuthMiddleware(fullDeps));
  app.get("/test", (c) => {
    const auth = c.get("paykitAuth");
    return c.json({ tenant: auth.tenant, plane: auth.plane });
  });
  return { app, deps: fullDeps };
}

// ---------------------------------------------------------------------------
// API Key Middleware
// ---------------------------------------------------------------------------

describe("apiKeyAuthMiddleware", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const { app } = buildApiKeyApp();
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 when key format is invalid (not pk_ prefix)", async () => {
    const { app } = buildApiKeyApp();
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer invalid_key_format" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("returns 401 when key is revoked", async () => {
    const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: ["checkout:write"] });
    const { app } = buildApiKeyApp({
      findByHash: vi.fn().mockResolvedValue({
        keyId: "key-1",
        merchantId: MERCHANT_ID,
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        mode: "live",
        scopes: ["checkout:write"],
        lastUsedAt: null,
        revokedAt: new Date(), // REVOKED
        createdAt: new Date(),
      }),
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("returns 401 when key is not found in DB", async () => {
    const { app } = buildApiKeyApp({
      findByHash: vi.fn().mockResolvedValue(null),
    });

    const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: [] });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it("sets paykitAuth with correct tenant and plane on valid key", async () => {
    const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: ["checkout:write", "balance:read"] });
    const { app } = buildApiKeyApp({
      findByHash: vi.fn().mockResolvedValue({
        keyId: "key-1",
        merchantId: MERCHANT_ID,
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        mode: "live",
        scopes: ["checkout:write", "balance:read"],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      }),
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant).toEqual(TENANT);
    expect(body.plane).toBe("api_key");
  });

  it("calls touchLastUsed after successful auth (fire-and-forget)", async () => {
    const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: ["checkout:write"] });
    const touchLastUsed = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApiKeyApp({
      findByHash: vi.fn().mockResolvedValue({
        keyId: "key-99",
        merchantId: MERCHANT_ID,
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        mode: "live",
        scopes: ["checkout:write"],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      }),
      touchLastUsed,
    });

    await app.request("/test", {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });

    // Give fire-and-forget a tick to execute
    await new Promise((r) => setTimeout(r, 10));
    expect(touchLastUsed).toHaveBeenCalledWith(expect.anything(), "key-99");
  });
});

// ---------------------------------------------------------------------------
// JWT Middleware
// ---------------------------------------------------------------------------

describe("jwtAuthMiddleware", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const { app } = buildJwtApp();
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("returns 401 for expired token", async () => {
    const token = await sign(
      {
        sub: MERCHANT_ID,
        tenant_id: TENANT.tenantId,
        owner_id: TENANT.ownerId,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        scopes: [],
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
      },
      TEST_SECRET,
      "HS256",
    );

    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for alg:none token (algorithm confusion attack)", async () => {
    // Manually craft a token with alg:none
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: MERCHANT_ID,
        tenant_id: TENANT.tenantId,
        owner_id: TENANT.ownerId,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        scopes: [],
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const fakeToken = `${header}.${payload}.`;

    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("returns 401 for non-HS256 signed token (HS/RS confusion prevention)", async () => {
    // Craft a token header claiming RS256 but signed with HS256 secret
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: MERCHANT_ID,
        tenant_id: TENANT.tenantId,
        owner_id: TENANT.ownerId,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        scopes: [],
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    // Sign with HMAC but claim RS256 — middleware must reject based on header.alg check
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", TEST_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const fakeToken = `${header}.${payload}.${sig}`;

    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("returns 401 when iss claim is missing or wrong", async () => {
    const token = await makeJwtToken({ iss: "wrong-issuer" });
    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("returns 401 when aud claim is missing or wrong", async () => {
    const token = await makeJwtToken({ aud: "wrong-audience" });
    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("returns 500 when secret loader fails (secret too short or unavailable)", async () => {
    const { app } = buildJwtApp({
      loadSecret: vi.fn().mockRejectedValue(new Error("secret too short")),
    });

    const token = await makeJwtToken({});
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_CONFIG_ERROR");
  });

  it("sets paykitAuth with plane jwt on valid token", async () => {
    const token = await makeJwtToken({});
    const { app } = buildJwtApp();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant).toEqual(TENANT);
    expect(body.plane).toBe("jwt");
  });
});

// ---------------------------------------------------------------------------
// Plane Separation
// ---------------------------------------------------------------------------

describe("plane separation", () => {
  it("rejects api_key token on a jwt-only (dashboard) route", async () => {
    const app = new Hono();
    const jwtDeps = makeJwtDeps();
    app.use("*", jwtAuthMiddleware(jwtDeps));
    app.get("/dashboard", (c) => c.json({ ok: true }));

    // Send a pk_ key to a JWT-protected route
    const minted = mintApiKey({ merchantId: MERCHANT_ID, mode: "live", scopes: [] });
    const res = await app.request("/dashboard", {
      headers: { Authorization: `Bearer ${minted.plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects jwt token on an api_key-only (/v1) route via requirePlane", async () => {
    const app = new Hono();
    const jwtDeps = makeJwtDeps();
    // Simulate: JWT middleware sets auth, then requirePlane('api_key') rejects
    app.use("*", jwtAuthMiddleware(jwtDeps));
    app.use("*", requirePlane("api_key"));
    app.get("/v1/balance", (c) => c.json({ ok: true }));

    const token = await makeJwtToken({});
    const res = await app.request("/v1/balance", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: service mode with no auth = 401
// ---------------------------------------------------------------------------

describe("fail-closed behavior", () => {
  it("/v1 request with no paykitAuth set returns 401 (not tenant from header)", async () => {
    const app = new Hono();
    // No auth middleware mounted — simulates misconfiguration or bypass attempt
    // Route has no tenantResolver (service mode)
    const { buildBalanceRoute } = await import("../src/routes/billing/balance-route.js");
    app.route("/", buildBalanceRoute({ db: {} as never }));

    const res = await app.request("/balance", {
      headers: { "X-Tenant-Id": "attacker-tenant-id" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// requireScope
// ---------------------------------------------------------------------------

describe("requireScope", () => {
  it("returns 401 when no auth context is set", async () => {
    const app = new Hono();
    app.use("*", requireScope("checkout:write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("returns 403 when required scope is missing", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("paykitAuth", {
        merchantId: MERCHANT_ID,
        tenant: TENANT,
        scopes: ["balance:read"],
        plane: "api_key" as const,
      });
      await next();
    });
    app.use("*", requireScope("checkout:write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("passes when required scope is present", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("paykitAuth", {
        merchantId: MERCHANT_ID,
        tenant: TENANT,
        scopes: ["checkout:write", "balance:read"],
        plane: "api_key" as const,
      });
      await next();
    });
    app.use("*", requireScope("checkout:write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("returns 403 when plane restriction is violated", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("paykitAuth", {
        merchantId: MERCHANT_ID,
        tenant: TENANT,
        scopes: ["key:manage"],
        plane: "api_key" as const,
      });
      await next();
    });
    // key:manage requires jwt plane (dashboard only)
    app.use("*", requireScope({ scopes: ["key:manage"], plane: "jwt" }));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// createJwtSecretLoader
// ---------------------------------------------------------------------------

describe("createJwtSecretLoader", () => {
  it("throws when existing secret is shorter than 32 bytes", async () => {
    const loader = createJwtSecretLoader({
      getKey: vi.fn().mockResolvedValue({ value: "short" }),
      setKey: vi.fn(),
      db: {} as never,
    });

    await expect(loader()).rejects.toThrow("too short");
  });

  it("generates and seeds a new secret when none exists", async () => {
    const setKey = vi.fn().mockImplementation(async (_db, input) => ({
      value: input.value,
    }));
    const loader = createJwtSecretLoader({
      getKey: vi.fn().mockResolvedValue(undefined),
      setKey,
      db: {} as never,
    });

    const secret = await loader();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(setKey).toHaveBeenCalledOnce();
  });

  it("caches the secret on subsequent calls", async () => {
    const getKey = vi.fn().mockResolvedValue({ value: TEST_SECRET });
    const loader = createJwtSecretLoader({
      getKey,
      setKey: vi.fn(),
      db: {} as never,
    });

    await loader();
    await loader();
    // Only one DB call due to caching
    expect(getKey).toHaveBeenCalledOnce();
  });
});
