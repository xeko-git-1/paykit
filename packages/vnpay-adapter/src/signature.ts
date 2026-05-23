/**
 * VNPay HMAC-SHA512 signature for redirect URL + IPN webhook.
 *
 * Spec: VNPay merchant docs v2.1.0
 *   - Sort params alphabetically (excluding vnp_SecureHash and vnp_SecureHashType)
 *   - Build canonical query string with strict RFC 3986 encoding
 *   - HMAC-SHA512 with merchant's vnp_HashSecret → lowercase hex
 *   - Compare constant-time
 *
 * Rotation supported via secrets array (string | string[]).
 */
import { createHmac } from "node:crypto";
import { buildCanonicalString } from "./url-encoder.js";

export function signParams(params: Record<string, string>, hashSecret: string): string {
  const canonical = buildCanonicalString(params);
  return createHmac("sha512", hashSecret).update(canonical, "utf-8").digest("hex");
}

/** Verify with rotation grace — first match wins. */
export function verifySignature(
  params: Record<string, string>,
  hashSecrets: readonly string[],
  receivedSignature: string,
): boolean {
  if (!receivedSignature || receivedSignature === "") return false;
  const canonical = buildCanonicalString(params);
  const lowerReceived = receivedSignature.toLowerCase();
  let matched = false;
  for (const secret of hashSecrets) {
    const expected = createHmac("sha512", secret).update(canonical, "utf-8").digest("hex");
    if (expected.length !== lowerReceived.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ lowerReceived.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  return matched;
}
