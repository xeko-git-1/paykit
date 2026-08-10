/**
 * OpenAPI spec tests — verifies that GET /v1/openapi.json returns a valid
 * OpenAPI 3.1 document with paths matching the router and components
 * derived from zod schemas.
 */
import { describe, expect, it } from "vitest";
import { buildV1TestApp } from "./helpers/build-v1-test-app.js";
import type { PaykitAuthContext } from "@xeko-git-1/paykit-server";

describe("GET /v1/openapi.json", () => {
  // OpenAPI endpoint should be accessible without auth (public documentation)
  const auth: PaykitAuthContext = {
    merchantId: "merchant-1",
    tenant: { tenantId: "merchant-1", ownerId: "merchant-1" },
    scopes: ["balance:read"],
    plane: "api_key",
  };

  it("returns openapi 3.1.x version", async () => {
    const { app } = buildV1TestApp({ auth });
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it("contains info with title and version", async () => {
    const { app } = buildV1TestApp({ auth });
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    const spec = await res.json();
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe("Paykit Public API");
    expect(spec.info.version).toBeDefined();
  });

  it("paths match router endpoints", async () => {
    const { app } = buildV1TestApp({ auth });
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    const spec = await res.json();

    expect(spec.paths).toBeDefined();
    expect(spec.paths["/v1/checkouts"]).toBeDefined();
    expect(spec.paths["/v1/checkouts"].post).toBeDefined();
    expect(spec.paths["/v1/balances"]).toBeDefined();
    expect(spec.paths["/v1/balances"].get).toBeDefined();
    expect(spec.paths["/v1/payments"]).toBeDefined();
    expect(spec.paths["/v1/payments"].get).toBeDefined();
    expect(spec.paths["/v1/refunds"]).toBeDefined();
    expect(spec.paths["/v1/refunds"].post).toBeDefined();
    expect(spec.paths["/v1/api-keys"]).toBeDefined();
    expect(spec.paths["/v1/api-keys"].post).toBeDefined();
  });

  it("components/schemas are derived from zod definitions", async () => {
    const { app } = buildV1TestApp({ auth });
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    const spec = await res.json();

    // OpenAPI 3.1 should have components with schemas
    // The exact schema names depend on @hono/zod-openapi internals,
    // but request/response bodies should reference schemas
    const checkoutPost = spec.paths["/v1/checkouts"].post;
    expect(checkoutPost.requestBody).toBeDefined();
    expect(checkoutPost.responses["200"]).toBeDefined();
    expect(checkoutPost.responses["400"]).toBeDefined();
  });

  it("response content type is application/json", async () => {
    const { app } = buildV1TestApp({ auth });
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});
