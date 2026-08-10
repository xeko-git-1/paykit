/**
 * Hashing and redacting a webhook body before it becomes durable.
 *
 * Storing a delivery is what makes replay possible, and it is also the moment a
 * secret or a customer's details stop being transient. Both concerns are handled
 * here, in one place, so the router cannot accidentally store a body that skipped
 * either step.
 *
 * The two are deliberately independent:
 *
 *   - The hash is taken over the body EXACTLY as received. It is what detects two
 *     deliveries claiming the same event id with different content, so it has to
 *     describe the bytes the provider sent, not a version we rewrote.
 *   - The stored payload is redacted. A webhook body can carry provider secrets,
 *     bearer tokens, and PII, and none of those become less sensitive by having
 *     arrived over HTTP. Redaction is why the hash cannot be recomputed from the
 *     stored copy — which is exactly why the hash is stored separately.
 */
import { createHash } from "node:crypto";
import { redactString } from "@xeko-git-1/paykit";

/**
 * Upper bound on a stored body, in characters.
 *
 * A provider that sends something enormous should not be able to make one row a
 * meaningful fraction of the table, and a body past this size is not something
 * anyone reads during an incident anyway. The hash still covers the whole body, so
 * truncation never weakens tamper detection.
 */
const MAX_STORED_PAYLOAD_CHARS = 64 * 1024;

const TRUNCATION_MARKER = "…[truncated]";

/**
 * sha256 of the body as received, hex-encoded.
 *
 * Taken before redaction, so this is a fingerprint of what the provider actually
 * sent. Comparing it across deliveries of one event id is how a changed body is
 * noticed.
 */
export function hashRawBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * The body in the form it may be stored: secrets and PII replaced, oversized
 * payloads cut.
 *
 * `extraPatterns` comes from the tenant's `observability.redact` configuration, so
 * a provider-specific token shape can be covered without changing this module.
 */
export function redactRawBody(rawBody: string, extraPatterns: readonly RegExp[] = []): string {
  const redacted = redactString(rawBody, extraPatterns);
  if (redacted.length <= MAX_STORED_PAYLOAD_CHARS) return redacted;
  return `${redacted.slice(0, MAX_STORED_PAYLOAD_CHARS)}${TRUNCATION_MARKER}`;
}
