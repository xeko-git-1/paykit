/**
 * ZaloPay 2-key signature builder.
 *
 * Spec: ZaloPay Open API v2
 *   - **key1** signs `/v2/create` request body (server → ZaloPay)
 *   - **key2** verifies callback POST from ZaloPay (ZaloPay → server)
 *   - **app_trans_id** format: `YYMMDD_<id>` (Vietnam timezone UTC+7)
 *
 * Each endpoint has its own canonical string format — see helper builders.
 */
import { createHmac } from "node:crypto";

export function signWithKey1(canonical: string, key1: string): string {
  return createHmac("sha256", key1).update(canonical, "utf-8").digest("hex");
}

export function signWithKey2(canonical: string, key2: string): string {
  return createHmac("sha256", key2).update(canonical, "utf-8").digest("hex");
}

/** Build app_trans_id in ZaloPay's required format YYMMDD_<id> using UTC+7 (Vietnam) date. */
export function buildAppTransId(uniqueId: string, now: Date = new Date()): string {
  const offsetMs = 7 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  const yy = String(local.getUTCFullYear()).slice(-2);
  const MM = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  return `${yy}${MM}${dd}_${uniqueId}`;
}

/**
 * Create-order canonical: `app_id|app_trans_id|app_user|amount|app_time|embed_data|item`
 * Signed with key1.
 */
export function buildCreateCanonical(opts: {
  appId: string;
  appTransId: string;
  appUser: string;
  amount: string;
  appTime: string;
  embedData: string;
  item: string;
}): string {
  return `${opts.appId}|${opts.appTransId}|${opts.appUser}|${opts.amount}|${opts.appTime}|${opts.embedData}|${opts.item}`;
}

/**
 * Callback canonical: ZaloPay POSTs `{ data, mac, type }`. The `data` field is a JSON
 * string; `mac` is HMAC-SHA256(data, key2). Adapter verifies by recomputing.
 */
export function buildCallbackCanonical(rawDataField: string): string {
  return rawDataField;
}

export function verifyCallbackMac(
  rawDataField: string,
  key2s: readonly string[],
  receivedMac: string,
): boolean {
  if (!receivedMac || receivedMac === "") return false;
  let matched = false;
  let validKeyChecked = false;
  for (const k of key2s) {
    // An empty HMAC key yields an attacker-computable digest — skip to prevent forgery.
    if (!k || k.trim() === "") continue;
    validKeyChecked = true;
    const expected = signWithKey2(rawDataField, k);
    if (expected.length !== receivedMac.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ receivedMac.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  // Fail closed: if no valid key was available, verification must not succeed.
  if (!validKeyChecked) return false;
  return matched;
}

/**
 * Refund canonical: `app_id|zp_trans_id|amount|description|timestamp`
 * Signed with key1.
 */
export function buildRefundCanonical(opts: {
  appId: string;
  zpTransId: string;
  amount: string;
  description: string;
  timestamp: string;
}): string {
  return `${opts.appId}|${opts.zpTransId}|${opts.amount}|${opts.description}|${opts.timestamp}`;
}
