/**
 * Webhook route isolation test — defense-in-depth verification that webhook
 * paths are structurally unreachable by the auth/rate-limit middleware glob.
 *
 * Provider IPN callbacks hitting /webhooks/* must never receive 401/429.
 * This test enumerates all mounted routes and asserts no webhook path sits
 * under the /v1 prefix (which carries auth + rate-limit middleware).
 */
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/build-test-app.js";

describe("webhook route isolation", () => {
  it("no webhook path is mounted under /v1 (auth/rate-limit prefix)", async () => {
    const app = await buildTestApp();

    // Enumerate all registered routes from Hono's internal router
    const routes = app.routes;
    const webhookRoutes = routes.filter(
      (r) => r.path.includes("webhook") || r.path.includes("/webhooks"),
    );
    const v1Routes = routes.filter((r) => r.path.startsWith("/v1"));

    // Structural assertion: no webhook path starts with /v1
    for (const wr of webhookRoutes) {
      expect(wr.path).not.toMatch(/^\/v1/);
    }

    // Positive assertion: webhook routes exist at top-level /webhooks
    expect(webhookRoutes.length).toBeGreaterThan(0);
    for (const wr of webhookRoutes) {
      expect(wr.path).toMatch(/^\/webhooks/);
    }

    // Negative assertion: /v1 routes do NOT contain any webhook path
    for (const v1r of v1Routes) {
      expect(v1r.path).not.toMatch(/webhook/i);
    }
  });

  it("POST /webhooks/sepay is processed (2xx), not rejected by auth/rate-limit", async () => {
    const app = await buildTestApp();

    // Simulate a provider IPN callback — no auth header
    const res = await app.request(
      new Request("http://localhost/webhooks/sepay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 123, transferType: "in" }),
      }),
    );

    // Assert a concrete 2xx — not merely "not 401/429" — so the route is proven
    // both reachable AND handled. The mock adapter returns a null event, so the
    // handler ACKs with 200 received/skipped. A 500 from a wiring bug now fails.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
    const body = (await res.json()) as { received?: boolean };
    expect(body.received).toBe(true);
  });
});
