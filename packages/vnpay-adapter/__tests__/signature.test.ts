import { describe, expect, it } from "vitest";
import { signParams, verifySignature } from "../src/signature.js";
import { buildCanonicalString, encodeRfc3986 } from "../src/url-encoder.js";

const HASH_SECRET = "test_hash_secret_v1";

describe("encodeRfc3986", () => {
  it("encodes spaces as %20 (NOT +)", () => {
    expect(encodeRfc3986("hello world")).toBe("hello%20world");
  });

  it("encodes Vietnamese unicode", () => {
    expect(encodeRfc3986("Đơn hàng")).toBe("%C4%90%C6%A1n%20h%C3%A0ng");
  });

  it("preserves unreserved chars (A-Z a-z 0-9 - _ . ~)", () => {
    expect(encodeRfc3986("abc-XYZ_123.tilde~")).toBe("abc-XYZ_123.tilde~");
  });

  it("encodes reserved chars (! ' ( ) *)", () => {
    expect(encodeRfc3986("!*()'")).toBe("%21%2A%28%29%27");
  });
});

describe("buildCanonicalString", () => {
  it("sorts params alphabetically and joins with &", () => {
    const params = {
      vnp_Amount: "100000",
      vnp_TxnRef: "tx-1",
      vnp_Command: "pay",
    };
    const result = buildCanonicalString(params);
    expect(result).toBe("vnp_Amount=100000&vnp_Command=pay&vnp_TxnRef=tx-1");
  });

  it("excludes vnp_SecureHash and vnp_SecureHashType", () => {
    const params = {
      vnp_Amount: "100000",
      vnp_SecureHash: "abc",
      vnp_SecureHashType: "SHA512",
      vnp_TxnRef: "tx-1",
    };
    const result = buildCanonicalString(params);
    expect(result).toBe("vnp_Amount=100000&vnp_TxnRef=tx-1");
  });

  it("encodes values with strict RFC 3986", () => {
    const params = { vnp_OrderInfo: "Don hang 123" };
    expect(buildCanonicalString(params)).toBe("vnp_OrderInfo=Don%20hang%20123");
  });
});

describe("signParams + verifySignature", () => {
  const params = {
    vnp_Amount: "10000000",
    vnp_TxnRef: "tx-abc-123",
    vnp_Command: "pay",
    vnp_TmnCode: "TMNCODE1",
  };

  it("signs and verifies in round-trip", () => {
    const signature = signParams(params, HASH_SECRET);
    expect(verifySignature(params, [HASH_SECRET], signature)).toBe(true);
  });

  it("rejects tampered param", () => {
    const signature = signParams(params, HASH_SECRET);
    const tampered = { ...params, vnp_Amount: "20000000" };
    expect(verifySignature(tampered, [HASH_SECRET], signature)).toBe(false);
  });

  it("verifies with rotation array (old + new secrets)", () => {
    const signature = signParams(params, "secret_old");
    expect(verifySignature(params, ["secret_old", "secret_new"], signature)).toBe(true);
    expect(verifySignature(params, ["secret_new", "secret_old"], signature)).toBe(true);
  });

  it("rejects when secret not in rotation list", () => {
    const signature = signParams(params, "wrong_secret");
    expect(verifySignature(params, [HASH_SECRET], signature)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifySignature(params, [HASH_SECRET], "")).toBe(false);
  });

  it("returns lowercase hex", () => {
    const signature = signParams(params, HASH_SECRET);
    expect(signature).toBe(signature.toLowerCase());
    expect(signature).toMatch(/^[0-9a-f]{128}$/); // SHA512 = 128 hex chars
  });

  it("constant-time-style: same length wrong content rejected", () => {
    const signature = signParams(params, HASH_SECRET);
    const wrongLength = "a".repeat(signature.length);
    expect(verifySignature(params, [HASH_SECRET], wrongLength)).toBe(false);
  });
});
