import { describe, expect, it } from "vitest";
import {
  buildCreateOrderCanonical,
  buildIpnCanonical,
  buildRefundCanonical,
  sign,
  verifyIpnSignature,
} from "../src/signature.js";

const SECRET = "momo_test_secret";

describe("Momo canonical strings", () => {
  it("buildCreateOrderCanonical orders fields alphabetically with & separator", () => {
    const canonical = buildCreateOrderCanonical({
      accessKey: "ak",
      amount: "100000",
      extraData: "",
      ipnUrl: "https://app.example/ipn",
      orderId: "tx-1",
      orderInfo: "Payment tx-1",
      partnerCode: "MOMOTEST",
      redirectUrl: "https://app.example/return",
      requestId: "req-1",
      requestType: "payWithMethod",
    });
    expect(canonical).toBe(
      "accessKey=ak&amount=100000&extraData=&ipnUrl=https://app.example/ipn&orderId=tx-1&orderInfo=Payment tx-1&partnerCode=MOMOTEST&redirectUrl=https://app.example/return&requestId=req-1&requestType=payWithMethod",
    );
  });

  it("buildIpnCanonical sorts alphabetically + excludes signature", () => {
    const canonical = buildIpnCanonical({
      orderId: "tx-1",
      resultCode: "0",
      signature: "abc",
      amount: "100000",
    });
    expect(canonical).toBe("amount=100000&orderId=tx-1&resultCode=0");
  });

  it("buildRefundCanonical orders fields alphabetically", () => {
    const canonical = buildRefundCanonical({
      accessKey: "ak",
      amount: "100000",
      description: "refund reason",
      orderId: "tx-1-refund",
      partnerCode: "MOMOTEST",
      requestId: "req-r-1",
      transId: "trans-99",
    });
    expect(canonical).toBe(
      "accessKey=ak&amount=100000&description=refund reason&orderId=tx-1-refund&partnerCode=MOMOTEST&requestId=req-r-1&transId=trans-99",
    );
  });
});

describe("Momo sign + verifyIpnSignature", () => {
  const params = {
    partnerCode: "MOMOTEST",
    orderId: "tx-1",
    requestId: "req-1",
    amount: "100000",
    resultCode: "0",
    transId: "trans-99",
  };

  it("verifies in round-trip", () => {
    const canonical = buildIpnCanonical(params);
    const signature = sign(canonical, SECRET);
    expect(verifyIpnSignature(params, [SECRET], signature)).toBe(true);
  });

  it("rejects tampered amount", () => {
    const canonical = buildIpnCanonical(params);
    const signature = sign(canonical, SECRET);
    const tampered = { ...params, amount: "999999" };
    expect(verifyIpnSignature(tampered, [SECRET], signature)).toBe(false);
  });

  it("verifies with rotation array", () => {
    const canonical = buildIpnCanonical(params);
    const oldSig = sign(canonical, "secret_old");
    expect(verifyIpnSignature(params, ["secret_old", "secret_new"], oldSig)).toBe(true);
  });

  it("rejects empty signature", () => {
    expect(verifyIpnSignature(params, [SECRET], "")).toBe(false);
  });

  it("returns 64-char hex (SHA256)", () => {
    const signature = sign("test", SECRET);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Momo — empty-secret forgery prevention", () => {
  const params = { partnerCode: "MOMOTEST", orderId: "tx-1", amount: "100000", resultCode: "0" };

  it("rejects signature computed with empty secret (forgery vector)", () => {
    const canonical = buildIpnCanonical(params);
    const forgedSig = sign(canonical, "");
    expect(verifyIpnSignature(params, [""], forgedSig)).toBe(false);
  });

  it("rejects when all secrets are empty or whitespace-only", () => {
    const canonical = buildIpnCanonical(params);
    const forgedSig = sign(canonical, "");
    expect(verifyIpnSignature(params, ["", "  "], forgedSig)).toBe(false);
  });

  it("still verifies with valid secret alongside empty ones", () => {
    const canonical = buildIpnCanonical(params);
    const validSig = sign(canonical, SECRET);
    expect(verifyIpnSignature(params, ["", SECRET, ""], validSig)).toBe(true);
  });
});
