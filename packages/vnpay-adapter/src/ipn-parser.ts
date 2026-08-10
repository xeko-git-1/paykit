/**
 * VNPay IPN parser — converts form-urlencoded body OR query string params
 * into NormalizedWebhookEvent.
 *
 * Response code mapping (VNPay v2.1.0):
 *   00: success → payment.completed
 *   24: cancelled → unknown (skip; paykit doesn't credit)
 *   01-23, 75-79, 99: various failures → payment.failed
 */
import type { NormalizedWebhookEvent, WebhookEventType } from "@xeko-git-1/paykit";

/** Parse application/x-www-form-urlencoded body or URL search string into params object. */
export function parseFormUrlencoded(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairs = rawBody.split("&").filter((p) => p.length > 0);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eq));
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    params[key] = value;
  }
  return params;
}

function mapResponseCode(code: string): WebhookEventType {
  if (code === "00") return "payment.completed";
  if (code === "24") return "unknown";
  return "payment.failed";
}

export function paramsToWebhookEvent(
  params: Record<string, string>,
): NormalizedWebhookEvent | null {
  const txnRef = params.vnp_TxnRef;
  if (!txnRef) return null;
  const responseCode = params.vnp_ResponseCode ?? "99";
  const type = mapResponseCode(responseCode);
  if (type === "unknown") return null;

  // VNPay vnp_Amount is in cents (× 100). Convert to micros for VND-native (× 10_000 = micros).
  // VND-native micros = VND × 1_000_000. VNPay sends VND × 100. So divide by 100, multiply by 1_000_000.
  const vnpAmount = params.vnp_Amount;
  let amountMicros: string | undefined;
  if (vnpAmount !== undefined && /^\d+$/.test(vnpAmount)) {
    const vnd = BigInt(vnpAmount) / 100n;
    amountMicros = (vnd * 1_000_000n).toString();
  }

  // eventId — VNPay doesn't send a unique event id; combine TxnRef + TransactionNo for dedup.
  const transactionNo = params.vnp_TransactionNo ?? "0";
  const eventId = `vnpay:${txnRef}:${transactionNo}`;

  return {
    eventId,
    type,
    providerRef: txnRef,
    ...(amountMicros !== undefined ? { amountMicros } : {}),
    currencyCode: "VND",
    metadata: {
      vnp_ResponseCode: responseCode,
      vnp_TransactionNo: transactionNo,
      vnp_BankCode: params.vnp_BankCode,
      vnp_PayDate: params.vnp_PayDate,
      vnp_TransactionStatus: params.vnp_TransactionStatus,
      vnp_OrderInfo: params.vnp_OrderInfo,
    },
  };
}
