import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SePayClient } from "../src/providers/sepay/client.js";

const SECRET_OLD = "secret_v1_old";
const SECRET_NEW = "secret_v2_new";
const cfg = {
  apiKey: "ak",
  secretKey: [SECRET_OLD, SECRET_NEW],
  accountNumber: "0",
  accountName: "P",
  bankBin: "970422",
};

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("SePayClient.verifyWebhookSignature", () => {
  const client = new SePayClient(cfg);
  const payload = JSON.stringify({ id: "evt-1", transferType: "in", transferAmount: 1000 });

  it("accepts signature from current secret", () => {
    expect(client.verifyWebhookSignature(payload, sign(payload, SECRET_NEW))).toBe(true);
  });

  it("accepts signature from old secret during rotation grace", () => {
    expect(client.verifyWebhookSignature(payload, sign(payload, SECRET_OLD))).toBe(true);
  });

  it("rejects signature signed with wrong secret", () => {
    expect(client.verifyWebhookSignature(payload, sign(payload, "unknown_secret"))).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(client.verifyWebhookSignature(payload, "")).toBe(false);
  });

  it("works with single-string secretKey config (no array)", () => {
    const single = new SePayClient({ ...cfg, secretKey: SECRET_NEW });
    expect(single.verifyWebhookSignature(payload, sign(payload, SECRET_NEW))).toBe(true);
    expect(single.verifyWebhookSignature(payload, sign(payload, "x"))).toBe(false);
  });

  it("uses constant-time compare (basic timing sanity, not statistical)", () => {
    const validSig = sign(payload, SECRET_NEW);
    const wrongLengthMatch = "a".repeat(validSig.length);
    expect(client.verifyWebhookSignature(payload, wrongLengthMatch)).toBe(false);
  });
});

describe("SePayClient — empty-secret forgery prevention", () => {
  const payload = JSON.stringify({ id: "evt-forge", transferType: "in", transferAmount: 500 });

  it("rejects signature computed with empty secret", () => {
    const client = new SePayClient({ ...cfg, secretKey: [""] });
    const forgedSig = sign(payload, "");
    expect(client.verifyWebhookSignature(payload, forgedSig)).toBe(false);
  });

  it("rejects when all secrets are empty or whitespace-only", () => {
    const client = new SePayClient({ ...cfg, secretKey: ["", "  "] });
    const forgedSig = sign(payload, "");
    expect(client.verifyWebhookSignature(payload, forgedSig)).toBe(false);
  });

  it("still verifies with valid secret alongside empty ones", () => {
    const client = new SePayClient({ ...cfg, secretKey: ["", SECRET_NEW, ""] });
    const validSig = sign(payload, SECRET_NEW);
    expect(client.verifyWebhookSignature(payload, validSig)).toBe(true);
  });
});
