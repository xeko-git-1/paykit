/**
 * Fetch-back webhook authentication for PayPal.
 *
 * PayPal signs webhooks with a certificate-based scheme whose local
 * verification needs the merchant's webhook id plus a CRC32 + RSA check
 * against a downloaded certificate. This adapter does not trust the body at
 * all instead: the delivery only names a resource id, and the authoritative
 * state is re-read from PayPal's API with the merchant's own credentials. A
 * forged delivery can therefore only make paykit ask PayPal about an id —
 * which either belongs to this merchant (and its real state is used) or 404s.
 *
 * Capture happens HERE. An Orders v2 order moves no money until the merchant
 * captures it after the payer approves, so CHECKOUT.ORDER.APPROVED triggers
 * the capture call. The call carries PayPal-Request-Id = the order id, so a
 * redelivered approval (or a concurrent PAYMENT.CAPTURE.COMPLETED path)
 * returns the first capture instead of attempting a second one.
 *
 * Both paths emit the same eventId (`paypal:capture.completed:<capture id>`),
 * and the ledger credit is unique on (provider, provider_ref), so seeing the
 * same payment through both events credits it once.
 *
 * Errors: a transport failure or a 5xx THROWS, so the router answers 502 and
 * PayPal redelivers. A 404 resolves to null — the id is not this merchant's.
 */
import type { NormalizedWebhookEvent } from "@xeko-git-1/paykit";
import { paypalValueToMicros } from "./amounts.js";
import type { PaypalClient, PaypalResponse } from "./paypal-client.js";
import type {
  PaypalCapture,
  PaypalOrder,
  PaypalRefund,
  PaypalWebhookEnvelope,
} from "./paypal-types.js";

/** PayPal resource ids are uppercase alphanumerics; anything else never reaches a URL. */
const RESOURCE_ID = /^[A-Z0-9-]{1,64}$/;

function assertAnswered(res: PaypalResponse<unknown>, what: string): boolean {
  if (res.ok) return true;
  if (res.status === 404) return false;
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`PayPal ${what} failed: HTTP ${res.status}`);
  }
  return false;
}

export function captureToEvent(
  capture: PaypalCapture,
  fallbackReference: string | undefined,
  orderId: string | undefined,
): NormalizedWebhookEvent | null {
  if (capture.status !== "COMPLETED" || typeof capture.id !== "string") return null;
  const reference = capture.custom_id ?? fallbackReference;
  if (typeof reference !== "string" || reference === "") return null;
  const amountMicros = paypalValueToMicros(capture.amount?.value);
  const currency = capture.amount?.currency_code;
  if (amountMicros === null || typeof currency !== "string") return null;
  const relatedOrder = orderId ?? capture.supplementary_data?.related_ids?.order_id;
  return {
    eventId: `paypal:capture.completed:${capture.id}`,
    type: "payment.completed",
    providerRef: reference,
    amountMicros,
    currencyCode: currency.toUpperCase(),
    // The refund API keys on the CAPTURE id, which only exists after capture.
    providerPaymentId: capture.id,
    metadata: {
      paypalCaptureId: capture.id,
      ...(relatedOrder !== undefined ? { paypalOrderId: relatedOrder } : {}),
    },
  };
}

function orderToEvent(order: PaypalOrder): NormalizedWebhookEvent | null {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (unit === undefined || capture === undefined) return null;
  return captureToEvent(capture, unit.custom_id, order.id);
}

export function createWebhookResolver(client: PaypalClient) {
  async function getOrder(orderId: string): Promise<PaypalOrder | null> {
    const res = await client.request<PaypalOrder>(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    return assertAnswered(res, "get order") ? (res.body ?? null) : null;
  }

  async function captureApprovedOrder(orderId: string): Promise<NormalizedWebhookEvent | null> {
    const res = await client.request<PaypalOrder>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      { body: {}, requestId: `paykit-capture-${orderId}` },
    );
    if (res.ok && res.body !== undefined) return orderToEvent(res.body);
    if (res.status >= 500 || res.status === 429) {
      throw new Error(`PayPal capture order failed: HTTP ${res.status}`);
    }
    // 422 ORDER_ALREADY_CAPTURED and friends: the order's own state is the
    // answer — it carries the capture made by the earlier attempt.
    const order = await getOrder(orderId);
    return order === null ? null : orderToEvent(order);
  }

  async function resolveCapture(
    captureId: string,
    wanted: "completed" | "failed",
  ): Promise<NormalizedWebhookEvent | null> {
    const res = await client.request<PaypalCapture>(
      "GET",
      `/v2/payments/captures/${encodeURIComponent(captureId)}`,
    );
    if (!assertAnswered(res, "get capture") || res.body === undefined) return null;
    const capture = res.body;

    let reference = capture.custom_id;
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if ((reference === undefined || reference === "") && orderId !== undefined) {
      reference = (await getOrder(orderId))?.purchase_units?.[0]?.custom_id;
    }

    if (wanted === "completed") return captureToEvent(capture, reference, orderId);
    if (capture.status !== "DECLINED" && capture.status !== "FAILED") return null;
    if (typeof reference !== "string" || reference === "") return null;
    return {
      eventId: `paypal:capture.${capture.status.toLowerCase()}:${captureId}`,
      type: "payment.failed",
      providerRef: reference,
      metadata: { paypalCaptureId: captureId },
    };
  }

  async function resolveRefund(refundId: string): Promise<NormalizedWebhookEvent | null> {
    const res = await client.request<PaypalRefund>(
      "GET",
      `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
    );
    if (!assertAnswered(res, "get refund") || res.body === undefined) return null;
    const refund = res.body;
    if (refund.status !== "COMPLETED" || typeof refund.id !== "string") return null;

    // API-made refunds carry paykit's reference in custom_id. A refund made in
    // PayPal's dashboard does not, so its parent capture (the `up` link) is
    // asked instead — the capture always carries the checkout's custom_id.
    let reference = refund.custom_id;
    if (reference === undefined || reference === "") {
      const up = refund.links?.find((l) => l.rel === "up")?.href;
      const captureId = up?.split("/captures/")[1]?.split(/[/?]/)[0];
      if (captureId !== undefined && RESOURCE_ID.test(captureId)) {
        const cap = await client.request<PaypalCapture>(
          "GET",
          `/v2/payments/captures/${encodeURIComponent(captureId)}`,
        );
        if (assertAnswered(cap, "get capture")) reference = cap.body?.custom_id;
      }
    }
    if (typeof reference !== "string" || reference === "") return null;

    const refundMicros = paypalValueToMicros(refund.amount?.value);
    const currency = refund.amount?.currency_code;
    if (refundMicros === null || typeof currency !== "string") return null;
    return {
      eventId: `paypal:refund.completed:${refund.id}`,
      type: "payment.refunded",
      providerRef: reference,
      refundAmountMicros: refundMicros,
      currencyCode: currency.toUpperCase(),
      providerRefundId: refund.id,
      metadata: {},
    };
  }

  return async function resolve(rawBody: string): Promise<NormalizedWebhookEvent | null> {
    let envelope: PaypalWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody) as PaypalWebhookEnvelope;
    } catch {
      return null;
    }
    const resourceId = envelope.resource?.id;
    if (typeof resourceId !== "string" || !RESOURCE_ID.test(resourceId)) return null;

    switch (envelope.event_type) {
      case "CHECKOUT.ORDER.APPROVED":
        return captureApprovedOrder(resourceId);
      case "PAYMENT.CAPTURE.COMPLETED":
        return resolveCapture(resourceId, "completed");
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.DECLINED":
        return resolveCapture(resourceId, "failed");
      case "PAYMENT.CAPTURE.REFUNDED":
        return resolveRefund(resourceId);
      default:
        return null;
    }
  };
}
