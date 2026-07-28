/**
 * Binance Pay signatures. Note the two schemes are NOT the same primitive:
 *
 *  - Outbound REST requests are signed by the merchant with a SYMMETRIC key:
 *      hex(HMAC_SHA512(payload, apiSecret)).toUpperCase()
 *  - Inbound webhooks are signed by Binance with an ASYMMETRIC key:
 *      RSA-SHA256 verify over base64(BinancePay-Signature) using Binance's
 *      public key.
 *
 * Both sign the same canonical payload, which includes a TRAILING newline —
 * three separators in total, one after each part:
 *
 *      timestamp + "\n" + nonce + "\n" + body + "\n"
 *
 * "\n" is LF (0x0A). The body must be the exact raw bytes sent/received; any
 * re-serialization changes the digest and the verification fails.
 *
 * Header names arrive from the HTTP layer in arbitrary case (Hono lowercases
 * them, other stacks may not), so lookups are case-insensitive.
 */
import { createHmac, createVerify } from "node:crypto";

export const BINANCE_TIMESTAMP_HEADER = "binancepay-timestamp";
export const BINANCE_NONCE_HEADER = "binancepay-nonce";
export const BINANCE_SIGNATURE_HEADER = "binancepay-signature";
export const BINANCE_CERT_SN_HEADER = "binancepay-certificate-sn";

/** Build the canonical payload both signature schemes cover. */
export function buildSignaturePayload(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

/** Case-insensitive header read — HTTP header names are not case-sensitive. */
export function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string" && direct !== "") return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

/** Merchant request signature: uppercase hex HMAC-SHA512 over the payload. */
export function signRequest(
  timestamp: string,
  nonce: string,
  body: string,
  apiSecret: string,
): string {
  return createHmac("sha512", apiSecret)
    .update(buildSignaturePayload(timestamp, nonce, body), "utf-8")
    .digest("hex")
    .toUpperCase();
}

/**
 * Binance Pay requires the nonce to be exactly 32 characters drawn from a-zA-Z.
 * Digits are deliberately excluded: the docs describe looping 32 times over the
 * letter alphabet, and a stricter charset is always accepted.
 */
const NONCE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function generateNonce(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(32);
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    // Modulo bias over a 52-letter alphabet is negligible for a replay nonce;
    // the nonce only needs uniqueness per request, not uniform secrecy.
    nonce += NONCE_ALPHABET[(bytes[i] ?? 0) % NONCE_ALPHABET.length];
  }
  return nonce;
}

/**
 * Normalize a Binance `certPublic` into PEM. The Query Certificate API returns
 * the key already PEM-wrapped, but merchants who paste it from the dashboard
 * often lose the header/footer, so bare base64 is wrapped here rather than
 * failing verification with a confusing crypto error.
 */
export function normalizePublicKey(certPublic: string): string {
  const trimmed = certPublic.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const wrapped = (trimmed.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

/**
 * Verify an inbound Binance Pay webhook.
 *
 * Accepts multiple public keys so a Binance certificate rotation does not drop
 * in-flight webhooks (same rotation tolerance as the other adapters' secret
 * arrays). Returns false — never throws — on any missing header, malformed
 * base64, or unusable key, so a bad webhook becomes a 401 rather than a 500
 * that would make Binance retry a request we will never accept.
 */
export function verifyBinanceWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  publicKeys: readonly string[],
): boolean {
  const timestamp = readHeader(headers, BINANCE_TIMESTAMP_HEADER);
  const nonce = readHeader(headers, BINANCE_NONCE_HEADER);
  const signature = readHeader(headers, BINANCE_SIGNATURE_HEADER);
  if (!timestamp || !nonce || !signature) return false;

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (signatureBytes.length === 0) return false;

  const payload = buildSignaturePayload(timestamp, nonce, rawBody);

  for (const key of publicKeys) {
    if (!key || key.trim() === "") continue;
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(payload, "utf-8");
      verifier.end();
      if (verifier.verify(normalizePublicKey(key), signatureBytes)) return true;
    } catch {
      // Malformed key or signature length mismatch — try the next key.
    }
  }
  return false;
}
