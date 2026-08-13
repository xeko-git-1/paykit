/**
 * VNPay HMAC-SHA512 signature for redirect URL + IPN webhook.
 *
 * Spec: VNPay merchant docs v2.1.0
 *   - Sort params alphabetically (excluding vnp_SecureHash and vnp_SecureHashType)
 *   - Build canonical query string with strict RFC 3986 encoding
 *   - HMAC-SHA512 with merchant's vnp_HashSecret → lowercase hex
 *   - Compare constant-time
 *
 * Rotation supported via secrets array (string | string[]).
 */
import { createHmac } from "node:crypto";
import { buildCanonicalString } from "./url-encoder.js";

export function signParams(params: Record<string, string>, hashSecret: string): string {
  const canonical = buildCanonicalString(params);
  return createHmac("sha512", hashSecret).update(canonical, "utf-8").digest("hex");
}

/**
 * Checksum for the merchant_webapi querydr request.
 *
 * Unlike the payment URL, the transaction API does NOT use the sorted
 * query-string canonical: the spec pins an explicit pipe-joined field order —
 * vnp_RequestId|vnp_Version|vnp_Command|vnp_TmnCode|vnp_TxnRef|
 * vnp_TransactionDate|vnp_CreateDate|vnp_IpAddr|vnp_OrderInfo — hashed with
 * HMAC-SHA512. Signing with the URL canonical yields code 97 (invalid
 * checksum) on every call.
 */
export function signQuerydr(
  fields: {
    requestId: string;
    version: string;
    command: string;
    tmnCode: string;
    txnRef: string;
    transactionDate: string;
    createDate: string;
    ipAddr: string;
    orderInfo: string;
  },
  hashSecret: string,
): string {
  const data = [
    fields.requestId,
    fields.version,
    fields.command,
    fields.tmnCode,
    fields.txnRef,
    fields.transactionDate,
    fields.createDate,
    fields.ipAddr,
    fields.orderInfo,
  ].join("|");
  return createHmac("sha512", hashSecret).update(data, "utf-8").digest("hex");
}

/** Verify with rotation grace — first match wins. */
export function verifySignature(
  params: Record<string, string>,
  hashSecrets: readonly string[],
  receivedSignature: string,
): boolean {
  if (!receivedSignature || receivedSignature === "") return false;
  const canonical = buildCanonicalString(params);
  const lowerReceived = receivedSignature.toLowerCase();
  let matched = false;
  let validSecretChecked = false;
  for (const secret of hashSecrets) {
    // An empty HMAC key yields an attacker-computable digest — skip to prevent forgery.
    if (!secret || secret.trim() === "") continue;
    validSecretChecked = true;
    const expected = createHmac("sha512", secret).update(canonical, "utf-8").digest("hex");
    if (expected.length !== lowerReceived.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ lowerReceived.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  // Fail closed: if no valid secret was available, verification must not succeed.
  if (!validSecretChecked) return false;
  return matched;
}
