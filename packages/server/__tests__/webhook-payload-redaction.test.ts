/**
 * What may become durable when a webhook body is stored.
 *
 * Storing the delivery is what makes replay possible, and it is also the moment a
 * secret stops being transient: before the inbox, a raw body existed only for the
 * length of a request. So the rule is that nothing reaches `raw_payload` without
 * passing through redaction, and the tamper check has to survive that — which is
 * why the hash is taken over the original bytes and kept in its own column.
 *
 * These are the two properties that must hold together, and they pull against each
 * other: redact enough that a leaked table row is not a credential dump, but keep a
 * fingerprint of what actually arrived so a changed body is still detectable.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashRawBody, redactRawBody } from "../src/services/webhook-payload-storage.js";

describe("redactRawBody", () => {
  it("removes Stripe secret keys", () => {
    const body = JSON.stringify({ key: "sk_live_abcdefgh12345678", amount: 100 });
    const out = redactRawBody(body);

    expect(out).not.toContain("sk_live_abcdefgh12345678");
    expect(out).toContain("[REDACTED]");
    // The rest of the body survives — a redacted payload must still be readable
    // enough to diagnose an incident from.
    expect(out).toContain("100");
  });

  it("removes webhook signing secrets", () => {
    const out = redactRawBody(JSON.stringify({ secret: "whsec_abcdefgh12345678" }));
    expect(out).not.toContain("whsec_abcdefgh12345678");
  });

  it("removes bearer tokens", () => {
    const out = redactRawBody(JSON.stringify({ auth: "Bearer eyJhbGciOi.J9.abc-123" }));
    expect(out).not.toContain("eyJhbGciOi.J9.abc-123");
  });

  it("removes card-shaped numbers", () => {
    const out = redactRawBody(JSON.stringify({ pan: "4111 1111 1111 1111" }));
    expect(out).not.toContain("4111 1111 1111 1111");
  });

  it("removes email addresses", () => {
    const out = redactRawBody(JSON.stringify({ email: "payer@example.com" }));
    expect(out).not.toContain("payer@example.com");
  });

  it("applies caller-supplied patterns for provider-specific token shapes", () => {
    // A provider whose token shape the defaults do not know about is covered through
    // configuration rather than by editing the redaction module.
    const out = redactRawBody(JSON.stringify({ token: "np_secret_9f8e7d" }), [
      /np_secret_[a-z0-9]+/g,
    ]);
    expect(out).not.toContain("np_secret_9f8e7d");
  });

  it("leaves an innocuous body untouched", () => {
    const body = JSON.stringify({ id: "evt_1", status: "succeeded", amount_micros: "25000000" });
    expect(redactRawBody(body)).toBe(body);
  });

  it("caps an oversized body and says that it did", () => {
    const huge = `{"pad":"${"x".repeat(200_000)}"}`;
    const out = redactRawBody(huge);

    // One provider sending something enormous must not make a single row a
    // meaningful fraction of the table.
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("[truncated]");
  });
});

describe("hashRawBody", () => {
  it("is the sha256 of the body exactly as received", () => {
    const body = JSON.stringify({ key: "sk_live_abcdefgh12345678" });
    expect(hashRawBody(body)).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });

  it("is taken before redaction, so it fingerprints what the provider sent", () => {
    const body = JSON.stringify({ key: "sk_live_abcdefgh12345678" });
    // If the hash were computed from the stored copy, two different secrets would
    // redact to the same text and hash identically — and a swapped body would pass
    // unnoticed.
    expect(hashRawBody(body)).not.toBe(hashRawBody(redactRawBody(body)));
  });

  it("distinguishes two bodies that redact to the same text", () => {
    const a = JSON.stringify({ key: "sk_live_aaaaaaaa11111111" });
    const b = JSON.stringify({ key: "sk_live_bbbbbbbb22222222" });

    expect(redactRawBody(a)).toBe(redactRawBody(b));
    // This is the property that makes the separate column worth its cost.
    expect(hashRawBody(a)).not.toBe(hashRawBody(b));
  });

  it("is stable for the same input", () => {
    const body = '{"id":"evt_1"}';
    expect(hashRawBody(body)).toBe(hashRawBody(body));
  });
});
