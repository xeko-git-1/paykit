/**
 * Paddle-Signature verification.
 *
 * The header carries `ts=<unix seconds>;h1=<hex hmac>` — possibly several `h1`
 * entries while an endpoint secret is being rotated. The signed payload is the
 * string `"{ts}:{rawBody}"` (raw body byte-for-byte, never re-serialized), the
 * MAC is HMAC-SHA256 with the endpoint's secret key (`pdl_ntfset_...`), hex
 * encoded lowercase.
 *
 * The timestamp bound defaults to 5 minutes. Paddle's own SDK defaults to a
 * much stricter 5 seconds, which assumes negligible queueing between Paddle
 * and this process; 5 minutes keeps replay protection while tolerating a slow
 * ingress hop. Callers can tighten it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyPaddleSignature(
  rawBody: string,
  headers: Record<string, string>,
  secrets: readonly string[],
  opts: { toleranceSeconds?: number; now?: () => number } = {},
): boolean {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.now ?? Date.now;

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const header = lower["paddle-signature"];
  if (!header) return false;

  let ts: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(";")) {
    const [key, value] = part.split("=", 2);
    if (key === "ts" && value !== undefined) ts = value;
    if (key === "h1" && value !== undefined) candidates.push(value);
  }
  if (ts === undefined || candidates.length === 0) return false;

  const tsNumber = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNumber)) return false;
  if (Math.abs(now() / 1000 - tsNumber) > tolerance) return false;

  const signedPayload = `${ts}:${rawBody}`;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
    for (const candidate of candidates) {
      if (constantTimeEqual(expected, candidate)) return true;
    }
  }
  return false;
}
