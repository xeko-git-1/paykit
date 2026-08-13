/**
 * Node-crypto BitpayMerchantSigner — merchant-facade ECDSA (secp256k1) request
 * signing without any external dependency.
 *
 * Scheme mirrored from BitPay's official Node SDK (KeyUtils in
 * bitpay/nodejs-bitpay-client):
 *   x-signature = hex( DER( ECDSA_secp256k1( SHA256(fullUrl + body) ) ) )
 *   x-identity  = compressed public key, hex (NOT the SIN — the SIN is only
 *                 used when pairing the client to obtain tokens)
 *
 * Key input accepts both formats BitPay tooling produces:
 *   - 32-byte private key hex (what the official SDKs generate and store)
 *   - PEM (SEC1 "EC PRIVATE KEY" or PKCS8 "PRIVATE KEY") on the secp256k1 curve
 *
 * STATUS: built from the published SDK sources and verified only against local
 * node:crypto round-trips. First live use against test.bitpay.com should
 * confirm BitPay accepts the identity/signature pair (a rejection surfaces as
 * HTTP 401 on POST /refunds — never as a wrong ledger write).
 */
import { type KeyObject, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import type { BitpayMerchantSigner } from "./adapter.js";

/** ASN.1 SEC1 ECPrivateKey prefix for secp256k1 with no embedded public key:
 *  SEQUENCE(0x2e) { INTEGER 1, OCTET STRING(32) <priv>, [0] OID 1.3.132.0.10 } */
const SEC1_PREFIX = Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x01, 0x04, 0x20]);
const SEC1_SUFFIX = Buffer.from([0xa0, 0x07, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);

function keyFromHex(privHex: string): KeyObject {
  const priv = Buffer.from(privHex, "hex");
  if (priv.length !== 32) {
    throw new Error(
      `BitPay merchant private key hex must be 32 bytes (64 hex chars); got ${priv.length} bytes`,
    );
  }
  const der = Buffer.concat([SEC1_PREFIX, priv, SEC1_SUFFIX]);
  return createPrivateKey({ key: der, format: "der", type: "sec1" });
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** Compressed SEC point (02/03 prefix + X) from the key's JWK export. */
function compressedPublicKeyHex(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as {
    crv?: string;
    x?: string;
    y?: string;
  };
  if (jwk.crv !== "secp256k1" || !jwk.x || !jwk.y) {
    throw new Error(
      `BitPay merchant key must be on secp256k1; got '${jwk.crv ?? "unknown"}'. Generate one with the BitPay SDK or: openssl ecparam -name secp256k1 -genkey`,
    );
  }
  const x = base64UrlToBuffer(jwk.x);
  const y = base64UrlToBuffer(jwk.y);
  const prefix = ((y[y.length - 1] ?? 0) & 1) === 1 ? 0x03 : 0x02;
  return Buffer.concat([Buffer.from([prefix]), x]).toString("hex");
}

/**
 * Build a BitpayMerchantSigner from a private key. `privateKey` is either
 * 64 hex chars (BitPay SDK format) or a PEM string.
 *
 * The identity is derived once at construction — a malformed key fails at boot
 * (loudly, before any refund is attempted), not on the first webhook.
 */
export function createNodeMerchantSigner(privateKey: string): BitpayMerchantSigner {
  const trimmed = privateKey.trim();
  const keyObject = trimmed.includes("-----BEGIN")
    ? createPrivateKey(trimmed)
    : keyFromHex(trimmed);
  const identity = compressedPublicKeyHex(keyObject);

  return {
    sign(fullUrl: string, body: string): { identity: string; signature: string } {
      const signer = createSign("SHA256");
      signer.update(fullUrl + body, "utf-8");
      signer.end();
      // Node emits ECDSA signatures DER-encoded by default, matching the SDK's
      // `signature.toDER()`.
      const signature = signer.sign(keyObject).toString("hex");
      return { identity, signature };
    },
  };
}
