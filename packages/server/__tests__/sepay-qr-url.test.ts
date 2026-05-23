import { describe, expect, it } from "vitest";
import { SePayClient } from "../src/providers/sepay/client.js";

const cfg = {
  apiKey: "ak_test",
  secretKey: "secret_test_123",
  accountNumber: "0123456789",
  accountName: "PAYKIT TEST",
  bankBin: "970422",
};

describe("SePayClient.generateQrUrl", () => {
  const client = new SePayClient(cfg);

  it("includes bankBin, accountNumber, amount, addInfo (description prefix)", () => {
    const r = client.generateQrUrl("abc-123", 100_000);
    expect(r.qrUrl).toContain(cfg.bankBin);
    expect(r.qrUrl).toContain(cfg.accountNumber);
    expect(r.qrUrl).toContain("amount=100000");
    expect(r.qrUrl).toMatch(/addInfo=PAYKIT(%20|\+)abc-123/);
  });

  it("returns the original orderId and amount", () => {
    const r = client.generateQrUrl("abc-123", 100_000);
    expect(r.orderId).toBe("abc-123");
    expect(r.amount).toBe(100_000);
  });

  it("sets a 30-minute expiry", () => {
    const before = Date.now();
    const r = client.generateQrUrl("abc-123", 100_000);
    const after = Date.now();
    const expectedMin = before + 29 * 60 * 1000;
    const expectedMax = after + 31 * 60 * 1000;
    expect(r.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});

describe("SePayClient.extractOrderId", () => {
  const client = new SePayClient(cfg);

  it("extracts order ID from valid PAYKIT prefix", () => {
    expect(client.extractOrderId("PAYKIT abc-123 thanks")).toBe("abc-123");
  });

  it("is case insensitive", () => {
    expect(client.extractOrderId("paykit ABC-123")).toBe("ABC-123");
  });

  it("returns null on no match", () => {
    expect(client.extractOrderId("random transfer")).toBeNull();
    expect(client.extractOrderId("")).toBeNull();
  });
});
