/**
 * Cryptomus signature — MD5( base64( jsonBody ) + apiKey ), hex-encoded.
 *
 * The signature is computed over the JSON body with the `sign` field removed,
 * then base64-encoded, concatenated with the merchant's payment API key, and
 * MD5-hashed. Both request signing and webhook verification use this scheme.
 *
 * CRITICAL — slash escaping: Cryptomus signs the body as PHP `json_encode`
 * serializes it, and PHP escapes forward slashes (`/` → `\/`) by default. URLs
 * in the payload (e.g. `url_callback`, the hosted `url`) contain slashes, so a
 * standard JS `JSON.stringify` produces a DIFFERENT byte string and the MD5
 * will not match. `phpJsonEncode` replays PHP's default escaping so the digest
 * agrees with Cryptomus.
 *
 * Rotation: accepts a secret array (matches the sepay/momo/vnpay/nowpayments
 * pattern) so a key can be rotated without dropping in-flight webhooks.
 *
 * Compare: manual constant-time string compare with a length pre-check (never
 * crypto.timingSafeEqual, which throws on length mismatch).
 */
import { createHash } from "node:crypto";

export const CRYPTOMUS_SIGNATURE_HEADER = "sign";

/**
 * Serialize a value the way PHP's `json_encode` does by default: like
 * JSON.stringify, but with forward slashes escaped (`/` → `\/`). Cryptomus
 * signs the PHP-encoded string, so the digest only matches if we escape too.
 */
export function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, "\\/");
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** MD5( base64(phpJsonEncode(body)) + apiKey ) — the Cryptomus sign scheme. */
export function computeCryptomusSignature(body: unknown, apiKey: string): string {
  const encoded = Buffer.from(phpJsonEncode(body), "utf-8").toString("base64");
  return createHash("md5")
    .update(encoded + apiKey, "utf-8")
    .digest("hex");
}

/**
 * Sign an outgoing request body. Returns both the `sign` digest and the exact
 * serialized bytes it was computed over, so the caller sends the same bytes as
 * the request body — otherwise a re-serialization (different slash escaping)
 * would not match the digest Cryptomus recomputes.
 */
export function computeCryptomusSign(
  body: unknown,
  apiKey: string,
): { sign: string; serialized: string } {
  const serialized = phpJsonEncode(body);
  const encoded = Buffer.from(serialized, "utf-8").toString("base64");
  const sign = createHash("md5")
    .update(encoded + apiKey, "utf-8")
    .digest("hex");
  return { sign, serialized };
}

/**
 * Verify a Cryptomus webhook. The signature travels INSIDE the JSON body under
 * the `sign` key (not a header), so it is stripped before hashing. Returns
 * false on unparseable body, missing sign, or no matching secret.
 */
export function verifyCryptomusSignature(rawBody: string, secrets: readonly string[]): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return false;
  }

  const received = typeof parsed.sign === "string" ? parsed.sign : "";
  if (received === "") return false;

  // The signature is computed over the body WITHOUT the sign field.
  const { sign: _sign, ...unsigned } = parsed;

  let matched = false;
  for (const secret of secrets) {
    if (!secret || secret.trim() === "") continue;
    const expected = computeCryptomusSignature(unsigned, secret);
    if (constantTimeStringEqual(expected, received)) matched = true;
  }
  return matched;
}
