/**
 * Plane-coexistence tests (F3) — the api-key and jwt middlewares are mutually
 * exclusive (api-key rejects non-pk_ tokens; jwt rejects pk_ tokens). The
 * authPlaneDispatcher routes by token shape so both planes work on /v1/*:
 *
 *   - pk_ token  → api-key plane  → can reach api_key-scoped routes (checkouts)
 *   - pk_ token  → mint route (requirePlane jwt) → 403/401 (plane rejection)
 *   - jwt token  → mint route → reaches the handler (plane accepted)
 *   - jwt token  → still rejected by api-key-only expectations appropriately
 *
 * This locks the coexistence behavior that makes POST /v1/api-keys reachable in
 * service mode without breaking s2s api-key traffic.
 */
import {
  type ApiKeyAuthDeps,
  JWT_AUDIENCE,
  JWT_ISSUER,
  SCOPES,
  apiKeyAuthMiddleware,
  authPlaneDispatcher,
  jwtAuthMiddleware,
  mintApiKey,
  requirePlane,
  requireScope,
} from "@xeko-git-1/paykit-server";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";

const SECRET = "a-very-long-test-secret-that-is-at-least-32-bytes!!";
const MERCHANT_ID = "merchant-coexist-1";

// A real key + matching mock lookup so the api-key plane verifies successfully.
const minted = mintApiKey({
  merchantId: MERCHANT_ID,
  mode: "live",
  scopes: [SCOPES.CHECKOUT_WRITE, SCOPES.KEY_MANAGE],
});

function buildDualPlaneApp() {
  const apiKeyDeps: ApiKeyAuthDeps = {
    db: {} as never,
    findByHash: async () => ({
      keyId: "k-1",
      merchantId: MERCHANT_ID,
      keyHash: minted.keyHash,
      keyPrefix: minted.keyPrefix,
      mode: "live",
      scopes: [SCOPES.CHECKOUT_WRITE, SCOPES.KEY_MANAGE],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }),
    touchLastUsed: async () => {},
    resolveMerchantTenant: async (id: string) => ({ tenantId: id, ownerId: id }),
  };

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
  // api_key-reachable route
  app.get("/v1/checkouts-probe", requireScope(SCOPES.CHECKOUT_WRITE), (c) =>
    c.json({ plane: c.get("paykitAuth")!.plane }),
  );
  // jwt-only route (mirrors POST /v1/api-keys plane guard)
  app.post("/v1/api-keys-probe", requirePlane("jwt"), requireScope(SCOPES.KEY_MANAGE), (c) =>
    c.json({ plane: c.get("paykitAuth")!.plane }),
  );
  return app;
}

async function jwtToken(scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: MERCHANT_ID,
      tenant_id: MERCHANT_ID,
      owner_id: MERCHANT_ID,
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

describe("F3 plane coexistence on /v1/*", () => {
  it("api_key token reaches an api_key-scoped route (jwt middleware does not reject it)", async () => {
    const app = buildDualPlaneApp();
    const res = await app.request(
      new Request("http://localhost/v1/checkouts-probe", {
        headers: { Authorization: `Bearer ${minted.plaintext}` },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).plane).toBe("api_key");
  });

  it("api_key token calling the jwt-only mint route is rejected (plane separation)", async () => {
    const app = buildDualPlaneApp();
    const res = await app.request(
      new Request("http://localhost/v1/api-keys-probe", {
        method: "POST",
        headers: { Authorization: `Bearer ${minted.plaintext}` },
      }),
    );
    // requirePlane("jwt") rejects an api_key-plane caller
    expect(res.status).toBe(401);
  });

  it("jwt token reaches the jwt-only mint route", async () => {
    const app = buildDualPlaneApp();
    const token = await jwtToken([SCOPES.KEY_MANAGE]);
    const res = await app.request(
      new Request("http://localhost/v1/api-keys-probe", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).plane).toBe("jwt");
  });

  it("missing Authorization header is rejected (jwt branch 401)", async () => {
    const app = buildDualPlaneApp();
    const res = await app.request(new Request("http://localhost/v1/checkouts-probe"));
    expect(res.status).toBe(401);
  });
});
