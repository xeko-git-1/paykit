/**
 * @xeko-git-1/paykit-vnpay — V1.5 adapter for VNPay redirect-based payments.
 *
 * Flow:
 *   1. createCheckout: build signed redirect URL (vnp_Amount × 100, HMAC-SHA512)
 *   2. Webhook IPN: VNPay POSTs form-urlencoded to consumer's ipnUrl
 *   3. parseWebhookPayload: verify HMAC, map vnp_ResponseCode → event type
 *   4. refund: POST to merchant_webapi /transaction with vnp_TransactionType=02 (full) or 03 (partial)
 */
export { createVnpayAdapter, type VnpayAdapterConfig } from "./adapter.js";
export { encodeRfc3986, buildCanonicalString } from "./url-encoder.js";
export { signParams, verifySignature } from "./signature.js";

export const PAYKIT_VNPAY_VERSION = "0.1.5-alpha.1";
