/**
 * creem-signature verification.
 *
 * Creem signs the raw request body with HMAC-SHA256 using the webhook secret
 * from the dashboard, hex encoded, and sends it in the `creem-signature`
 * header — no timestamp component, so unlike Polar/Paddle there is no
 * replay-window check to make here; replay protection is the inbox's
 * event-id dedup.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyCreemSignature(
  rawBody: string,
  headers: Record<string, string>,
  secrets: readonly string[],
): boolean {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const signature = lower["creem-signature"];
  if (signature === undefined || signature === "") return false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (constantTimeEqual(expected, signature)) return true;
  }
  return false;
}
