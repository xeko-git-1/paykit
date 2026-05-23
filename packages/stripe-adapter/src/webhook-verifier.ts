/**
 * Stripe webhook signature verification with rotation support.
 *
 * webhookSecret accepts string OR string[]; tries each in order, first
 * verification success returns the parsed event. All failures throw
 * paykit-typed `WebhookSignatureError`, never raw Stripe errors.
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
    `Stripe webhook signature did not match any of ${secrets.length} configured secret(s): ${lastErr instanceof Error ? lastErr.message : "unknown"}`,
  );
}
