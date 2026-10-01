/**
 * Capture refunds — POST /v2/payments/captures/{capture_id}/refund.
 *
 * RefundInput carries no currency, so the capture is read first: its amount
 * names the currency the refund value must be written in. The refund request
 * carries PayPal-Request-Id = paykit's idempotency key, so a retry after a
 * timeout returns the refund the first attempt created instead of a second.
 *
 * Ambiguous outcomes (network error, 5xx) map to `pending_webhook`, not
 * `failed`: with the idempotency key the first call may well have succeeded,
 * and releasing the reservation would let the same money be refunded twice.
 * PAYMENT.CAPTURE.REFUNDED settles the row, and the overdue-refund sweeper
 * surfaces it if no webhook ever comes.
 */
import {
  type CurrencyCode,
  type RefundInput,
  type RefundResult,
  isSupportedCurrencyCode,
} from "@xeko-git-1/paykit";
import { microsToPaypalValue } from "./amounts.js";
import { type PaypalClient, readPaypalError } from "./paypal-client.js";
import type { PaypalCapture, PaypalRefund } from "./paypal-types.js";

const CAPTURE_ID = /^[A-Z0-9-]{1,64}$/;

function ambiguous(message: string, code: string): RefundResult {
  return { state: "pending_webhook", error: { providerCode: code, message } };
}

export async function refundCapture(
  client: PaypalClient,
  input: RefundInput,
): Promise<RefundResult> {
  // input.providerRef is provider_payment_id ?? provider_ref — for PayPal the
  // capture id persisted from the completed event.
  const captureId = input.providerRef ?? "";
  if (!CAPTURE_ID.test(captureId)) {
    return {
      state: "failed",
      error: {
        providerCode: "MISSING_CAPTURE_ID",
        message: "no PayPal capture id on the payment row — the capture has not been recorded",
      },
    };
  }

  let currency: CurrencyCode;
  try {
    const cap = await client.request<PaypalCapture>(
      "GET",
      `/v2/payments/captures/${encodeURIComponent(captureId)}`,
    );
    if (!cap.ok) {
      return {
        state: "failed",
        error: {
          providerCode: `HTTP_${cap.status}`,
          message: `PayPal capture lookup failed: ${readPaypalError(cap.text)}`,
        },
      };
    }
    const code = cap.body?.amount?.currency_code?.toUpperCase();
    if (code === undefined || !isSupportedCurrencyCode(code)) {
      return {
        state: "failed",
        error: { providerCode: "UNKNOWN_CURRENCY", message: `capture currency '${code}'` },
      };
    }
    currency = code;
  } catch (err) {
    // Nothing has been sent to the refund endpoint yet, so this is a clean failure.
    return {
      state: "failed",
      error: {
        providerCode: "CAPTURE_LOOKUP_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  let res: Awaited<ReturnType<PaypalClient["request"]>>;
  try {
    res = await client.request<PaypalRefund>(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        requestId: input.idempotencyKey,
        body: {
          amount: {
            currency_code: currency,
            value: microsToPaypalValue(currency, input.amountMicros),
          },
          // Carries paykit's reference onto the refund resource, which is how
          // the refund webhook finds the payment row without a second lookup.
          custom_id: input.transactionId.slice(0, 127),
          note_to_payer: input.reason.slice(0, 255),
        },
      },
    );
  } catch (err) {
    return ambiguous(
      `PayPal refund call failed; awaiting webhook. ${err instanceof Error ? err.message : String(err)}`,
      "NETWORK_ERROR",
    );
  }

  if (res.status >= 500 || res.status === 429) {
    return ambiguous(
      `PayPal refund returned HTTP ${res.status}; awaiting webhook`,
      `HTTP_${res.status}`,
    );
  }
  if (!res.ok) {
    return {
      state: "failed",
      error: { providerCode: `HTTP_${res.status}`, message: readPaypalError(res.text) },
    };
  }

  const refund = res.body as PaypalRefund | undefined;
  const id = typeof refund?.id === "string" ? refund.id : undefined;
  if (refund?.status === "COMPLETED" && id !== undefined) {
    return { state: "completed", providerRefundId: id };
  }
  if (refund?.status === "PENDING") {
    return { state: "pending_webhook", ...(id !== undefined ? { providerRefundId: id } : {}) };
  }
  if (refund?.status === "CANCELLED" || refund?.status === "FAILED") {
    return {
      state: "failed",
      error: { providerCode: refund.status, message: `PayPal refund ${refund.status}` },
    };
  }
  return ambiguous(
    `PayPal refund answered with status '${refund?.status ?? "missing"}'; awaiting webhook`,
    "UNKNOWN_STATUS",
  );
}
