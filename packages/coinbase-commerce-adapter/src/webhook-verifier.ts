/**
 * Coinbase Commerce webhook signature — HMAC-SHA256, hex, over the raw body.
 *
 * The scheme is taken from Coinbase's own SDKs, which compute
 * `hmac_sha256(raw_payload, shared_secret).hexdigest()` and compare it against
 * the `X-CC-Webhook-Signature` header. Locally computable, so no call back to the
 * provider is needed to authenticate a delivery.
 *
 * The signature covers the bytes as received. Re-serializing the parsed JSON
 * before verifying would change key order and whitespace and never match, which
 * is why the router hands the raw string through untouched.
 */
import { createHmac } from "node:crypto";

export const COINBASE_COMMERCE_SIGNATURE_HEADER = "x-cc-webhook-signature";

export function computeCoinbaseCommerceSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Length-checked character-by-character comparison.
 *
 * `crypto.timingSafeEqual` throws when the two buffers differ in length, so a
 * malformed header would raise instead of returning false — turning a rejected
 * webhook into a 500. The length check is not itself secret: it is observable
 * from the header the caller sent.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a delivery against one or more shared secrets.
 *
 * Several secrets are accepted so a secret rotation does not drop webhooks that
 * were already in flight under the previous one. Every candidate is tried without
 * an early exit, and the function returns `false` rather than throwing: a
 * malformed or unsigned delivery is a rejection, not a server fault.
 */
export function verifyCoinbaseCommerceSignature(
  rawBody: string,
  headers: Record<string, string>,
  secrets: readonly string[],
): boolean {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }
  const provided = lowered[COINBASE_COMMERCE_SIGNATURE_HEADER];
  if (typeof provided !== "string" || provided === "") return false;

  let matched = false;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.trim() === "") continue;
    if (constantTimeStringEqual(computeCoinbaseCommerceSignature(rawBody, secret), provided)) {
      matched = true;
    }
  }
  return matched;
}
