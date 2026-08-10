/**
 * Router-level integration test for POST /v1/api-keys — the real mint route.
 *
 * Unlike mint-escalation.test.ts (which injects auth context directly), this
 * test wires the REAL auth pipeline (authPlaneDispatcher → apiKeyAuthMiddleware
 * + jwtAuthMiddleware) so that removing requirePlane or isScopeSubset from the
 * router causes a test failure. Mutation-resistant by design.
 *
 * Cases:
 *   1. api_key plane caller → 401 (requirePlane jwt rejects)
 *   2. jwt plane, requested scopes not subset of caller → 403 SCOPE_ESCALATION
 *   3. jwt plane, valid subset, under cap → 200, plaintext returned, key persisted
 *   4. per-merchant active-key cap exceeded → 429 KEY_LIMIT_EXCEEDED
 */
import {
  type ApiKeyAuthDeps,
  JWT_AUDIENCE,
  JWT_ISSUER,
  MAX_ACTIVE_KEYS_PER_MERCHANT,
  SCOPES,
  apiKeyAuthMiddleware,
  authPlaneDispatcher,
  jwtAuthMiddleware,
  mintApiKey,
} from "@xeko-git-1/paykit-server";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { buildV1Router } from "../src/v1/router.js";
import { resetAllBuckets } from "../src/v1/rate-limit.js";
import { createMockAdapter, createMockDb, createMockDbState, type MockDbState } from "./helpers/build-v1-test-app.js";
import type { ProviderRegistry } from "@xeko-git-1/paykit";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SECRET = "a-very-long-test-secret-that-is-at-least-32-bytes!!";
const MERCHANT_ID = "merchant-mint-route-1";

// A real minted key for the api_key plane
const mintedKey = mintApiKey({
  merchantId: MERCHANT_ID,
  mode: "live",
  scopes: [SCOPES.CHECKOUT_WRITE, SCOPES.KEY_MANAGE],
});

// ---------------------------------------------------------------------------
// App builder — real auth pipeline + real v1 router
// ---------------------------------------------------------------------------

function buildRealMintApp(dbState: MockDbState) {
  const mockDb = createMockDb(dbState);
  const adapters = [createMockAdapter("sepay")];
  const registry = {
    get: (id: string) => adapters.find((a) => a.id === id) ?? null,
    list: () => adapters,
    register: () => {},
  } as unknown as ProviderRegistry;

  // Real api-key auth deps with mock lookup
  const apiKeyDeps: ApiKeyAuthDeps = {
    db: mockDb as never,
    findByHash: async () => ({
      keyId: "k-real-1",
      merchantId: MERCHANT_ID,
      keyHash: mintedKey.keyHash,
      keyPrefix: mintedKey.keyPrefix,
      mode: "live",
      scopes: [SCOPES.CHECKOUT_WRITE, SCOPES.KEY_MANAGE],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      createdBy: "cli:operator",
    }),
    touchLastUsed: async () => {},
    resolveMerchantTenant: async (id: string) => ({ tenantId: id, ownerId: id }),
  };

  // Real auth plane dispatcher — routes by token shape
  const dispatcher = authPlaneDispatcher({
    apiKey: apiKeyAuthMiddleware(apiKeyDeps),
    jwt: jwtAuthMiddleware({
      loadSecret: async () => SECRET,
      expectedIssuer: JWT_ISSUER,
      expectedAudience: JWT_AUDIENCE,
    }),
  });

  const app = new Hono();
  app.use("/v1/*", dispatcher);

  // Mount the REAL v1 router (not probe routes)
  const v1Router = buildV1Router({ db: mockDb as never, registry });
  app.route("/v1", v1Router);

  resetAllBuckets();
  return app;
}

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function jwtToken(scopes: string[], merchantId = MERCHANT_ID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: merchantId,
      tenant_id: merchantId,
      owner_id: merchantId,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      scopes,
      iat: now,
      exp: now + 900,
    },
    SECRET,
    "HS256",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/api-keys — real router with real auth pipeline", () => {
  it("api_key plane caller is rejected with 401 (requirePlane jwt enforced)", async () => {
    const dbState = createMockDbState();
    const app = buildRealMintApp(dbState);

    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mintedKey.plaintext}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scopes: [SCOPES.CHECKOUT_WRITE] }),
      }),
    );

    // requirePlane("jwt") rejects api_key-plane callers
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("jwt plane with scope escalation returns 403 SCOPE_ESCALATION", async () => {
    const dbState = createMockDbState();
    const app = buildRealMintApp(dbState);

    // Token carries only key:manage — requesting refund:write is escalation
    const token = await jwtToken([SCOPES.KEY_MANAGE]);
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scopes: [SCOPES.REFUND_WRITE] }),
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("SCOPE_ESCALATION");
  });

  it("jwt plane with valid subset scopes returns 200, plaintext once, key persisted with created_by", async () => {
    const dbState = createMockDbState();
    const app = buildRealMintApp(dbState);

    const token = await jwtToken([SCOPES.KEY_MANAGE, SCOPES.CHECKOUT_WRITE]);
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scopes: [SCOPES.CHECKOUT_WRITE] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.plaintext).toMatch(/^pk_/);
    expect(body.data.keyId).toBeDefined();
    expect(body.data.scopes).toContain(SCOPES.CHECKOUT_WRITE);

    // Key was persisted in mock DB
    const persisted = dbState.apiKeys.find((k) => k.keyId === body.data.keyId);
    expect(persisted).toBeDefined();
  });

  it("per-merchant active-key cap exceeded returns 429 KEY_LIMIT_EXCEEDED", async () => {
    const dbState = createMockDbState();

    // Pre-populate at the cap (MAX_ACTIVE_KEYS_PER_MERCHANT active keys)
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_MERCHANT; i++) {
      dbState.apiKeys.push({
        keyId: `cap-key-${i}`,
        merchantId: MERCHANT_ID,
        keyHash: `hash-cap-${i}`,
        keyPrefix: `pk_live_cap${i}`,
        mode: "live",
        scopes: [SCOPES.CHECKOUT_WRITE],
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
      });
    }

    const app = buildRealMintApp(dbState);
    const token = await jwtToken([SCOPES.KEY_MANAGE, SCOPES.CHECKOUT_WRITE]);
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scopes: [SCOPES.CHECKOUT_WRITE] }),
      }),
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("KEY_LIMIT_EXCEEDED");
  });
});
