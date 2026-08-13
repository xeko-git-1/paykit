/**
 * createNodeMerchantSigner — local round-trip verification.
 *
 * The signature scheme itself (SHA256 → ECDSA secp256k1 → DER hex) is verified
 * with node:crypto's own verify; the identity format (compressed public key
 * hex) is checked structurally. What these tests CANNOT prove is that BitPay's
 * server accepts the pair — that is the live check flagged in
 * merchant-signer.ts.
 */
import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNodeMerchantSigner } from "../src/merchant-signer.js";

function generateSecp256k1Pem(): { privatePem: string; publicPem: string; privHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  const privHex = Buffer.from(jwk.d ?? "", "base64url")
    .toString("hex")
    .padStart(64, "0");
  return {
    privatePem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privHex,
  };
}

describe("createNodeMerchantSigner", () => {
  it("produces a DER signature node:crypto verifies over SHA256(url + body)", () => {
    const { privatePem, publicPem } = generateSecp256k1Pem();
    const signer = createNodeMerchantSigner(privatePem);

    const url = "https://test.bitpay.com/refunds";
    const body = '{"token":"tok","invoiceId":"inv1","amount":5}';
    const { signature } = signer.sign(url, body);

    const verifier = createVerify("SHA256");
    verifier.update(url + body, "utf-8");
    verifier.end();
    expect(verifier.verify(publicPem, Buffer.from(signature, "hex"))).toBe(true);
  });

  it("identity is the compressed public key hex (33 bytes, 02/03 prefix)", () => {
    const { privatePem } = generateSecp256k1Pem();
    const signer = createNodeMerchantSigner(privatePem);
    const { identity } = signer.sign("https://test.bitpay.com/invoices?token=t", "");

    expect(identity).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it("hex private key input yields the same identity as its PEM form", () => {
    const { privatePem, privHex } = generateSecp256k1Pem();
    const fromPem = createNodeMerchantSigner(privatePem).sign("u", "");
    const fromHex = createNodeMerchantSigner(privHex).sign("u", "");
    expect(fromHex.identity).toBe(fromPem.identity);
  });

  it("hex-keyed signature verifies against the derived public key", () => {
    const { privHex } = generateSecp256k1Pem();
    const signer = createNodeMerchantSigner(privHex);
    const { identity, signature } = signer.sign("https://test.bitpay.com/refunds/r1?token=t", "");

    // Rebuild the public key from the compressed-point identity and verify.
    const point = Buffer.from(identity, "hex");
    expect(point.length).toBe(33);
    // Round-trip through a JWK is the dependency-free way to build a KeyObject
    // from a raw point: node accepts only uncompressed JWK coordinates, so
    // verify via the private key's own public half instead.
    const priv = Buffer.from(privHex, "hex");
    const sec1 = Buffer.concat([
      Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x01, 0x04, 0x20]),
      priv,
      Buffer.from([0xa0, 0x07, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]),
    ]);
    const publicKey = createPublicKey(createPrivateKey({ key: sec1, format: "der", type: "sec1" }));

    const verifier = createVerify("SHA256");
    verifier.update("https://test.bitpay.com/refunds/r1?token=t", "utf-8");
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature, "hex"))).toBe(true);
  });

  it("rejects a non-secp256k1 PEM at construction, not at first sign", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => createNodeMerchantSigner(pem)).toThrow(/secp256k1/);
  });

  it("rejects a wrong-length hex key with an actionable message", () => {
    expect(() => createNodeMerchantSigner("abcd")).toThrow(/32 bytes/);
  });
});
