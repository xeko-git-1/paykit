/**
 * Standard Webhooks signature verification for Polar deliveries.
 *
 * Polar signs per https://www.standardwebhooks.com/: the signed content is
 * `{webhook-id}.{webhook-timestamp}.{rawBody}`, the MAC is HMAC-SHA256 encoded
 * base64, and the `webhook-signature` header carries one or more
 * space-separated `v1,<base64>` entries (multiple during key rotation).
 *
 * Secret encoding gotcha, confirmed against Polar's own SDK: the secret Polar
 * shows in its dashboard is a RAW string, not a `whsec_`-prefixed base64 one.
 * The HMAC key is therefore the UTF-8 bytes of that string as-is. (The SDK
 * base64-encodes it only to satisfy the standardwebhooks library's input
 * format, which immediately decodes it back.)
 *
 * The timestamp is bounded to ±5 minutes: outside that, a valid signature only
 * proves the delivery was captured once, not that it is happening now.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyPolarSignature(
  rawBody: string,
  headers: Record<string, string>,
  secrets: readonly string[],
  now: () => number = Date.now,
): boolean {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const id = lower["webhook-id"];
  const timestamp = lower["webhook-timestamp"];
  const signatureHeader = lower["webhook-signature"];
  if (!id || !timestamp || !signatureHeader) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const skewSeconds = Math.abs(now() / 1000 - ts);
  if (skewSeconds > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const candidates = signatureHeader
    .split(" ")
    .map((entry) => {
      const [version, sig] = entry.split(",", 2);
      return version === "v1" && sig !== undefined ? sig : null;
    })
    .filter((sig): sig is string => sig !== null);
  if (candidates.length === 0) return false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", Buffer.from(secret, "utf-8"))
      .update(signedContent)
      .digest("base64");
    for (const candidate of candidates) {
      if (constantTimeEqual(expected, candidate)) return true;
    }
  }
  return false;
}
