/**
 * V1 contract tests — verifies scope enforcement, DTO validation, and
 * error envelope shape across all /v1 endpoints.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { buildV1TestApp, createMockDbState } from "./helpers/build-v1-test-app.js";
import type { PaykitAuthContext } from "@vibecc/paykit-server";

const validApiKeyAuth: PaykitAuthContext = {
  merchantId: "merchant-1",
  tenant: { tenantId: "merchant-1", ownerId: "merchant-1" },
  scopes: ["checkout:write", "balance:read", "payments:read", "refund:write"],
  plane: "api_key",
};

describe("/v1 contract", () => {
  describe("scope enforcement", () => {
    it("GET /v1/balances with balance:read scope returns 200", async () => {
      const { app } = buildV1TestApp({ auth: validApiKeyAuth });
      const res = await app.request(new Request("http://localhost/v1/balances"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.apiVersion).toBeDefined();
      expect(body.data).toBeInstanceOf(Array);
    });

    it("GET /v1/balances without balance:read scope returns 403", async () => {
      const auth: PaykitAuthContext = {
        ...validApiKeyAuth,
        scopes: ["checkout:write"], // missing balance:read
      };
      const { app } = buildV1TestApp({ auth });
      const res = await app.request(new Request("http://localhost/v1/balances"));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("GET /v1/payments with payments:read scope returns 200", async () => {
      const { app } = buildV1TestApp({ auth: validApiKeyAuth });
      const res = await app.request(new Request("http://localhost/v1/payments"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.apiVersion).toBeDefined();
      expect(body.data).toBeInstanceOf(Array);
    });

    it("GET /v1/payments without payments:read scope returns 403", async () => {
      const auth: PaykitAuthContext = {
        ...validApiKeyAuth,
        scopes: ["balance:read"],
      };
      const { app } = buildV1TestApp({ auth });
      const res = await app.request(new Request("http://localhost/v1/payments"));
      expect(res.status).toBe(403);
    });

    it("POST /v1/checkouts without checkout:write scope returns 403", async () => {
      const auth: PaykitAuthContext = {
        ...validApiKeyAuth,
        scopes: ["balance:read"],
      };
      const { app } = buildV1TestApp({ auth });
      const res = await app.request(
        new Request("http://localhost/v1/checkouts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "sepay", amountVnd: 50000 }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("POST /v1/refunds without refund:write scope returns 403", async () => {
      const auth: PaykitAuthContext = {
        ...validApiKeyAuth,
        scopes: ["balance:read"],
      };
      const { app } = buildV1TestApp({ auth });
      const res = await app.request(
        new Request("http://localhost/v1/refunds", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-key-12345678",
          },
          body: JSON.stringify({
            transactionId: "b0000000-0000-4000-8000-000000000001",
            amountMicros: "1000000",
            reason: "test refund",
          }),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("no auth context returns 401", async () => {
      const { app } = buildV1TestApp({}); // no auth injected
      const res = await app.request(new Request("http://localhost/v1/balances"));
      expect(res.status).toBe(401);
    });
  });

  describe("validation — bad input returns 400 with error envelope", () => {
    it("POST /v1/checkouts with invalid body returns 400", async () => {
      const { app } = buildV1TestApp({ auth: validApiKeyAuth });
      const res = await app.request(
        new Request("http://localhost/v1/checkouts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountVnd: -100 }), // missing provider, negative amount
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBeDefined();
    });

    it("POST /v1/refunds with non-UUID transactionId returns 400", async () => {
      const { app } = buildV1TestApp({ auth: validApiKeyAuth });
      const res = await app.request(
        new Request("http://localhost/v1/refunds", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-key-12345678",
          },
          body: JSON.stringify({
            transactionId: "not-a-uuid",
            amountMicros: "1000000",
            reason: "test refund",
          }),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("POST /v1/api-keys with empty scopes returns 400", async () => {
      const jwtAuth: PaykitAuthContext = {
        ...validApiKeyAuth,
        plane: "jwt",
        scopes: ["key:manage", "checkout:write"],
      };
      const { app } = buildV1TestApp({ auth: jwtAuth });
      const res = await app.request(
        new Request("http://localhost/v1/api-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: [] }), // min 1 required
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("error envelope shape", () => {
    it("all errors have { error: { code, message } } shape", async () => {
      const { app } = buildV1TestApp({ auth: validApiKeyAuth });
      const res = await app.request(
        new Request("http://localhost/v1/checkouts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toHaveProperty("code");
      expect(body.error).toHaveProperty("message");
      expect(typeof body.error.code).toBe("string");
      expect(typeof body.error.message).toBe("string");
    });
  });
});
