/**
 * Mint escalation tests (F3 + F14) — verifies:
 * - api_key plane cannot call /v1/api-keys (plane rejection)
 * - Scope escalation is blocked (minted scopes must be subset of caller)
 * - merchantId from body is ignored (always uses auth context)
 * - Per-merchant DB-counted cap prevents unlimited key creation (durable)
 */
import { describe, expect, it } from "vitest";
import { buildV1TestApp, createMockDbState } from "./helpers/build-v1-test-app.js";
import type { PaykitAuthContext } from "@vibecc/paykit-server";

describe("/v1/api-keys mint escalation prevention", () => {
  const jwtAuth: PaykitAuthContext = {
    merchantId: "merchant-1",
    tenant: { tenantId: "merchant-1", ownerId: "merchant-1" },
    scopes: ["key:manage", "checkout:write", "balance:read"],
    plane: "jwt",
  };

  const apiKeyAuth: PaykitAuthContext = {
    merchantId: "merchant-1",
    tenant: { tenantId: "merchant-1", ownerId: "merchant-1" },
    scopes: ["key:manage", "checkout:write"],
    plane: "api_key",
  };

  it("api_key plane calling /v1/api-keys returns 401 (plane rejection)", async () => {
    const { app } = buildV1TestApp({ auth: apiKeyAuth });
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["checkout:write"] }),
      }),
    );

    // Plane rejection — api_key plane is not allowed to mint keys
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("caller scope [key:manage] minting key with scope [refund:write] not in caller returns 403", async () => {
    const { app } = buildV1TestApp({ auth: jwtAuth });
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["refund:write"] }), // not in jwtAuth.scopes
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("SCOPE_ESCALATION");
  });

  it("body merchantId is ignored — uses auth.merchantId", async () => {
    const dbState = createMockDbState();
    const { app } = buildV1TestApp({ auth: jwtAuth, dbState });
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopes: ["checkout:write"],
          merchantId: "attacker-merchant-id", // should be ignored
        }),
      }),
    );

    // .strict() rejects unknown keys like merchantId
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("per-merchant DB-counted cap: minting beyond active-key threshold returns 429 (durable)", async () => {
    const dbState = createMockDbState();
    // Pre-populate 10 active keys for merchant-1 (at the cap)
    for (let i = 0; i < 10; i++) {
      dbState.apiKeys.push({
        keyId: `key-${i}`,
        merchantId: "merchant-1",
        keyHash: `hash-${i}`,
        keyPrefix: `pk_live_${i}`,
        mode: "live",
        scopes: ["checkout:write"],
        revokedAt: null, // active (not revoked)
        lastUsedAt: null,
        createdAt: new Date(),
      });
    }

    const { app } = buildV1TestApp({ auth: jwtAuth, dbState });
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["checkout:write"] }),
      }),
    );

    // DB-counted cap exceeded — 429 (durable, survives restart)
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("KEY_LIMIT_EXCEEDED");
  });

  it("minting with valid subset scopes on jwt plane succeeds", async () => {
    const dbState = createMockDbState();
    const { app } = buildV1TestApp({ auth: jwtAuth, dbState });
    const res = await app.request(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["checkout:write"] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiVersion).toBeDefined();
    expect(body.data.plaintext).toMatch(/^pk_/);
    expect(body.data.keyId).toBeDefined();
    expect(body.data.scopes).toContain("checkout:write");
  });
});
