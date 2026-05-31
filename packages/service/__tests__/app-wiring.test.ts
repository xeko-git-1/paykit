/**
 * App wiring tests — verifies health endpoint, auth enforcement on /v1,
 * and fail-closed behavior when paykitAuth is absent.
 */
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/build-test-app.js";

describe("app wiring", () => {
  it("GET /healthz returns 200 without auth and without DB", async () => {
    const app = await buildTestApp();
    const res = await app.request(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /v1/balances without API key returns 401", async () => {
    const app = await buildTestApp();
    const res = await app.request(new Request("http://localhost/v1/balances"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toMatch(/AUTH/i);
    // Must not leak internal details
    expect(JSON.stringify(body)).not.toMatch(/stack|trace|internal/i);
  });

  it("POST /v1/checkout with absent paykitAuth returns 401 without leaking internals", async () => {
    const app = await buildTestApp();
    const res = await app.request(
      new Request("http://localhost/v1/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    // No internal error details exposed
    expect(body.error.code).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/TenantResolution|resolver|throw/i);
  });
});
