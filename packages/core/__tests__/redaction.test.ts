import { describe, expect, it } from "vitest";
import { redactObject, redactString } from "../src/observability/redaction.js";

describe("redactString", () => {
  it("redacts Stripe live secret keys", () => {
    expect(redactString("Authorization: sk_live_abc12345xyz")).toBe("Authorization: [REDACTED]");
  });

  it("redacts Stripe test secret keys", () => {
    expect(redactString("STRIPE_SECRET_KEY=sk_test_zzzzzzzzz")).toBe(
      "STRIPE_SECRET_KEY=[REDACTED]",
    );
  });

  it("redacts whsec_ webhook secrets", () => {
    expect(redactString("whsec_xyzabc123")).toBe("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    expect(redactString("Authorization: Bearer abc.def.xyz_-")).toBe("Authorization: [REDACTED]");
  });

  it("redacts credit-card-shaped numbers", () => {
    expect(redactString("card 4242 4242 4242 4242 ok")).toBe("card [REDACTED] ok");
  });

  it("redacts emails", () => {
    expect(redactString("user@example.com signed in")).toBe("[REDACTED] signed in");
  });

  it("does not redact unrelated text", () => {
    expect(redactString("Payment of 100 USD was completed")).toBe(
      "Payment of 100 USD was completed",
    );
  });
});

describe("redactObject", () => {
  it("redacts string values within nested objects", () => {
    const out = redactObject({
      ok: "fine",
      secret: "sk_live_xxxxxxxxxxxx",
      nested: { email: "u@example.com" },
    });
    expect(out).toEqual({
      ok: "fine",
      secret: "[REDACTED]",
      nested: { email: "[REDACTED]" },
    });
  });

  it("redacts arrays of strings", () => {
    expect(redactObject(["plain", "sk_test_xxxxxxxxxxxx"])).toEqual(["plain", "[REDACTED]"]);
  });

  it("preserves non-string types", () => {
    expect(redactObject({ count: 5, ok: true, n: null })).toEqual({
      count: 5,
      ok: true,
      n: null,
    });
  });
});
