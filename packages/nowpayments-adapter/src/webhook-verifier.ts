/**
 * NowPayments IPN signature verifier.
 *
 * Algorithm: HMAC-SHA512 over canonical JSON (sorted keys), hex-encoded.
 * Header:    x-nowpayments-sig
 * Secret:    string | readonly string[] (rotation array — RT F11; matches
 *            V1.5 momo/vnpay/sepay pattern)
 * Compare:   manual XOR with length pre-check (RT F14 — NOT
 *            crypto.timingSafeEqual which throws on length mismatch).
 *
 * Returns false on:
 *   - missing or empty signature header
 *   - body that fails JSON.parse
 *   - no secret matches (after trying all rotation entries)
 */
import { createHmac } from "node:crypto";
import { canonicalize } from "./canonical-json.js";

export const NP_SIGNATURE_HEADER = "x-nowpayments-sig";

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function computeNpSignature(canonicalBody: string, secret: string): string {
  return createHmac("sha512", secret).update(canonicalBody, "utf-8").digest("hex");
}

export function verifyNpSignature(
  rawBody: string,
  headers: Record<string, string>,
  secrets: readonly string[],
): boolean {
  const lower = lowerCaseHeaders(headers);
  const received = lower[NP_SIGNATURE_HEADER] ?? "";
  if (received === "") return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const canonical = canonicalize(parsed);

  let matched = false;
  for (const secret of secrets) {
    if (secret === "") continue;
    const expected = computeNpSignature(canonical, secret);
    if (constantTimeStringEqual(expected, received)) matched = true;
  }
  return matched;
}
