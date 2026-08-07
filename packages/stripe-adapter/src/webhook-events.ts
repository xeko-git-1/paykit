/**
 * Resolving a Stripe refund event back to the paykit payment it belongs to.
 *
 * A Refund points at a Charge, and a Charge points at a PaymentIntent. Neither
 * points at the Checkout Session — which is what `payment_transactions.provider_ref`
 * holds. So a refund event cannot be matched by following Stripe's object graph
 * downward; the link has to have been planted on the way in.
 *
 * `createCheckout` plants it, stamping the paykit transaction id onto the
 * PaymentIntent via `payment_intent_data.metadata`. A PaymentIntent copies its
 * metadata onto the Charge when the Charge is created, and a Refund created from
 * the Stripe Dashboard inherits nothing — so the Charge is the lowest object in
 * the graph that reliably carries the stamp, and reading it there is what makes a
 * Dashboard-initiated refund attributable at all.
 *
 * When the stamp is absent (a payment created before this stamping existed), the
 * charge or payment-intent id is used instead. That does not match a stored
 * provider_ref, so the server treats the refund as unmatched rather than guessing
 * — which is the outcome that keeps a wrong payment from being debited.
 */
import type Stripe from "stripe";

/** Metadata keys `createCheckout` stamps. Read back here, so they live together. */
export const PAYKIT_TRANSACTION_ID_KEY = "paykitTransactionId";
export const PAYKIT_TENANT_ID_KEY = "tenantId";
export const PAYKIT_OWNER_ID_KEY = "ownerId";

type StripeMetadata = Stripe.Metadata | null | undefined;

function readString(metadata: StripeMetadata, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The paykit identifiers stamped on a Stripe object, for the event's `metadata`.
 *
 * Carried through so the server can match a refund on the internal transaction id
 * when the provider reference does not resolve — the Dashboard-refund case.
 */
export function paykitRefs(metadata: StripeMetadata): Record<string, string> {
  const refs: Record<string, string> = {};
  const transactionId = readString(metadata, PAYKIT_TRANSACTION_ID_KEY);
  const tenantId = readString(metadata, PAYKIT_TENANT_ID_KEY);
  const ownerId = readString(metadata, PAYKIT_OWNER_ID_KEY);
  if (transactionId !== undefined) refs[PAYKIT_TRANSACTION_ID_KEY] = transactionId;
  if (tenantId !== undefined) refs[PAYKIT_TENANT_ID_KEY] = tenantId;
  if (ownerId !== undefined) refs[PAYKIT_OWNER_ID_KEY] = ownerId;
  return refs;
}

/**
 * The payment reference a refund event should carry.
 *
 * Prefers the Checkout Session id when it was stamped, because that is what the
 * payment row is keyed on. `fallback` is used otherwise and is deliberately a
 * charge or payment-intent id: it will not match a stored provider_ref, so the
 * server sees an unmatched refund instead of silently attributing it elsewhere.
 */
export function refundPaymentRef(metadata: StripeMetadata, fallback: string): string {
  return readString(metadata, "checkoutSessionId") ?? fallback;
}

/**
 * Best available Stripe-side reference on a Refund, when no session id was
 * stamped: the charge if present, else the payment intent, else the refund's own
 * id so the field is never empty.
 */
export function refundFallbackRef(refund: Stripe.Refund): string {
  if (typeof refund.charge === "string") return refund.charge;
  if (refund.charge !== null && refund.charge !== undefined) return refund.charge.id;
  if (typeof refund.payment_intent === "string") return refund.payment_intent;
  if (refund.payment_intent !== null && refund.payment_intent !== undefined) {
    return refund.payment_intent.id;
  }
  return refund.id;
}
