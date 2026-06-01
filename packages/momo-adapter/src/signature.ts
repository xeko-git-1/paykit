/**
 * Momo MMOP signature builder.
 *
 * Spec: payWithMethod v2 — canonical string is alphabetically-ordered key=value
 * pairs joined by `&`, signed with HMAC-SHA256 of merchant secretKey.
 *
 * Required canonical fields for create-order signing (in alphabetical order):
 *   accessKey, amount, extraData, ipnUrl, orderId, orderInfo, partnerCode,
 *   redirectUrl, requestId, requestType
 *
 * IPN signature uses a similar but distinct canonical: includes resultCode,
 * responseTime, etc. Each Momo API endpoint specifies its own canonical fields.
 */
import { createHmac } from "node:crypto";

export function buildCreateOrderCanonical(opts: {
  accessKey: string;
  amount: string;
  extraData: string;
  ipnUrl: string;
  orderId: string;
  orderInfo: string;
  partnerCode: string;
  redirectUrl: string;
  requestId: string;
  requestType: string;
}): string {
  return [
    `accessKey=${opts.accessKey}`,
    `amount=${opts.amount}`,
    `extraData=${opts.extraData}`,
    `ipnUrl=${opts.ipnUrl}`,
    `orderId=${opts.orderId}`,
    `orderInfo=${opts.orderInfo}`,
    `partnerCode=${opts.partnerCode}`,
    `redirectUrl=${opts.redirectUrl}`,
    `requestId=${opts.requestId}`,
    `requestType=${opts.requestType}`,
  ].join("&");
}

export function buildIpnCanonical(params: Record<string, string>): string {
  // Momo IPN canonical: alphabetical order, exclude `signature` field, join with &.
  const keys = Object.keys(params)
    .filter((k) => k !== "signature")
    .sort();
  return keys.map((k) => `${k}=${params[k] ?? ""}`).join("&");
}

export function buildRefundCanonical(opts: {
  accessKey: string;
  amount: string;
  description: string;
  orderId: string;
  partnerCode: string;
  requestId: string;
  transId: string;
}): string {
  return [
    `accessKey=${opts.accessKey}`,
    `amount=${opts.amount}`,
    `description=${opts.description}`,
    `orderId=${opts.orderId}`,
    `partnerCode=${opts.partnerCode}`,
    `requestId=${opts.requestId}`,
    `transId=${opts.transId}`,
  ].join("&");
}

export function sign(canonical: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(canonical, "utf-8").digest("hex");
}

export function verifyIpnSignature(
  params: Record<string, string>,
  secrets: readonly string[],
  receivedSignature: string,
): boolean {
  if (!receivedSignature || receivedSignature === "") return false;
  const canonical = buildIpnCanonical(params);
  let matched = false;
  let validSecretChecked = false;
  for (const secret of secrets) {
    // An empty HMAC key yields an attacker-computable digest — skip to prevent forgery.
    if (!secret || secret.trim() === "") continue;
    validSecretChecked = true;
    const expected = sign(canonical, secret);
    if (expected.length !== receivedSignature.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ receivedSignature.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  // Fail closed: if no valid secret was available, verification must not succeed.
  if (!validSecretChecked) return false;
  return matched;
}
