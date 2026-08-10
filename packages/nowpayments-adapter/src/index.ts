/**
 * @xeko-git-1/paykit-nowpayments — V3 adapter for crypto payments via NowPayments.
 *
 * Flow:
 *   1. createCheckout: POST /v1/invoice with USD amount → returns invoice_url
 *      (web + QR fallback). Customer pays in BTC/ETH/USDC/etc; NP gateway
 *      converts to USD and settles to merchant.
 *   2. IPN: NP POSTs JSON to consumer's webhook with x-nowpayments-sig header
 *      (HMAC-SHA512 over canonical sorted-JSON body).
 *   3. parseWebhookPayload: verify HMAC, map payment_status → event type.
 *   4. refund: POST /v1/payment/refund — on 4xx/5xx returns
 *      state='pending_webhook' (Val D8); webhook fires payment.refunded ≤24h
 *      later, paykit ledger writes via UNIQUE-protected appendLedgerEntryIdempotent.
 *
 * Sandbox: api.sandbox.nowpayments.io. Production: api.nowpayments.io.
 *
 * USD-only at the paykit ledger boundary. NP's `pay_currency` (BTC/ETH/etc)
 * is invisible to paykit; NP returns `outcome_amount` in USD.
 */
export { createNowpaymentsAdapter, type NowpaymentsAdapterConfig } from "./adapter.js";
export { canonicalize, sortKeysDeep } from "./canonical-json.js";
export {
  computeNpSignature,
  verifyNpSignature,
  NP_SIGNATURE_HEADER,
} from "./webhook-verifier.js";
export { mapStatusToEventType, parseNpIpn, type NpIpnPayload } from "./webhook-events.js";

export const PAYKIT_NOWPAYMENTS_VERSION = "0.3.0-rc.0";
