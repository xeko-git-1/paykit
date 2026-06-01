/**
 * /v1/openapi.json must be reachable WITHOUT a key (it is public API
 * documentation), while every other /v1/* route stays behind auth. This goes
 * through the real buildServiceApp wiring, so it proves the spec route is
 * mounted ahead of the auth glob — not just that a standalone handler exists.
 */
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/build-test-app.js";

describe("GET /v1/openapi.json (public, via real app wiring)", () => {
  it("returns 200 without an Authorization header", async () => {
    const app = await buildTestApp();
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it("still rejects other /v1 routes without a key (auth glob intact)", async () => {
    const app = await buildTestApp();
    const res = await app.request(new Request("http://localhost/v1/balances"));
    expect(res.status).toBe(401);
  });

  it("advertises a bearer security scheme so SDKs know auth is required", async () => {
    const app = await buildTestApp();
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    const spec = await res.json();
    expect(spec.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(spec.security).toContainEqual({ bearerAuth: [] });
  });

  it("declares the required Idempotency-Key header on POST /v1/refunds", async () => {
    const app = await buildTestApp();
    const res = await app.request(new Request("http://localhost/v1/openapi.json"));
    const spec = await res.json();
    const params = spec.paths["/v1/refunds"].post.parameters ?? [];
    const idem = params.find(
      (p: { name: string; in: string }) => p.name === "Idempotency-Key" && p.in === "header",
    );
    expect(idem).toBeDefined();
    expect(idem.required).toBe(true);
  });
});
