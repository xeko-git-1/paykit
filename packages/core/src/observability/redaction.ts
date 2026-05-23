/**
 * Redaction patterns — apply to log details / error messages before emit.
 *
 * V1 ships defaults for: Stripe sk_live_*, sk_test_*, whsec_*, generic Bearer
 * tokens, email, credit-card-shaped numbers.
 *
 * Consumer extends via `observability.redact: string[]` — additional regex
 * source strings appended to the default list.
 */

const DEFAULT_PATTERNS: readonly RegExp[] = [
  /sk_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe secret keys
  /whsec_[A-Za-z0-9]{8,}/g, // Stripe webhook secrets
  /Bearer\s+[A-Za-z0-9._-]+/g, // generic Bearer tokens
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // CC-shape numbers
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
];

export function redactString(input: string, extraPatterns: readonly RegExp[] = []): string {
  let out = input;
  for (const re of [...DEFAULT_PATTERNS, ...extraPatterns]) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function redactObject<T>(obj: T, extraPatterns: readonly RegExp[] = []): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactString(obj, extraPatterns) as unknown as T;
  if (typeof obj === "object") {
    if (Array.isArray(obj)) {
      return obj.map((v) => redactObject(v, extraPatterns)) as unknown as T;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = redactObject(v, extraPatterns);
    }
    return result as unknown as T;
  }
  return obj;
}
