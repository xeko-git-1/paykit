/**
 * Signature verification with rotation + per-instance secret pool (RT F7).
 *
 * Each adapter instance owns its own secret list. We do NOT share secrets
 * across instances; the route layer in Phase 06 dispatches webhooks by
 * adapter id (`/webhooks/{adapter.id}`), so each instance only ever sees its
 * own payloads. The verifier tries each configured secret in order and
 * throws WebhookSignatureError if none match.
 */
import { WebhookSignatureError } from "@vibecc/paykit";
import type Stripe from "stripe";

export function verifyAndParse(
  stripe: Stripe,
  rawBody: string,
  signature: string,
  webhookSecret: string | readonly string[],
): Stripe.Event {
  const secrets = Array.isArray(webhookSecret)
    ? (webhookSecret as readonly string[])
    : [webhookSecret as string];
  if (secrets.length === 0) {
    throw new WebhookSignatureError("No webhook secrets configured");
  }
  let lastErr: unknown = null;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new WebhookSignatureError(
    `Stripe Subscription webhook signature did not match any of ${secrets.length} secret(s): ${lastErr instanceof Error ? lastErr.message : "unknown"}`,
  );
}
