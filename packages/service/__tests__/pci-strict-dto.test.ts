/**
 * PCI strict DTO tests (F13) — verifies that .strict() zod schemas reject
 * unknown keys at the boundary, preventing accidental PAN/CVV leakage.
 */
import { describe, expect, it } from "vitest";
import { buildV1TestApp } from "./helpers/build-v1-test-app.js";
import type { PaykitAuthContext } from "@xeko-git-1/paykit-server";

const validAuth: PaykitAuthContext = {
  merchantId: "merchant-1",
  tenant: { tenantId: "merchant-1", ownerId: "merchant-1" },
  scopes: ["checkout:write", "refund:write"],
  plane: "api_key",
};

describe("PCI strict DTO enforcement (F13)", () => {
  it("POST /v1/checkouts with cardNumber in body returns 400 (strict rejects unknown)", async () => {
    const { app } = buildV1TestApp({ auth: validAuth });
    const res = await app.request(
      new Request("http://localhost/v1/checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "sepay",
          amountVnd: 50000,
          cardNumber: "4111111111111111", // PAN — must be rejected
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    // Verify the error mentions unrecognized key
    expect(body.error.message.toLowerCase()).toMatch(/unrecognized|unknown/);
  });

  it("POST /v1/checkouts with cvv in body returns 400 (strict rejects unknown)", async () => {
    const { app } = buildV1TestApp({ auth: validAuth });
    const res = await app.request(
      new Request("http://localhost/v1/checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "sepay",
          amountVnd: 50000,
          cvv: "123", // CVV — must be rejected
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /v1/refunds with extra fields returns 400 (strict rejects unknown)", async () => {
    const { app } = buildV1TestApp({ auth: validAuth });
    const res = await app.request(
      new Request("http://localhost/v1/refunds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-pci-test-001",
        },
        body: JSON.stringify({
          transactionId: "b0000000-0000-4000-8000-000000000001",
          amountMicros: "1000000",
          reason: "test refund",
          cardNumber: "4111111111111111", // must be rejected
          cvv: "999",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /v1/checkouts with only valid fields succeeds", async () => {
    const { app } = buildV1TestApp({ auth: validAuth });
    const res = await app.request(
      new Request("http://localhost/v1/checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "sepay",
          amountVnd: 50000,
        }),
      }),
    );

    // Should not be 400 — valid body passes strict check
    expect(res.status).not.toBe(400);
  });
});
