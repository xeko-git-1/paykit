/**
 * @vibecc/paykit-momo — V1.5 adapter for Momo e-wallet payments.
 *
 * Flow:
 *   1. createCheckout: POST /v2/gateway/api/create with HMAC-SHA256 signed body
 *      → returns { payUrl (web), deeplink (mobile), qrCodeUrl }
 *   2. IPN: Momo POSTs JSON to consumer's ipnUrl with `signature` field
 *   3. parseWebhookPayload: verify HMAC, map resultCode → event type
 *   4. refund: POST /v2/gateway/api/refund with idempotent requestId
 *
 * Sandbox: test-payment.momo.vn (requires MMOP partner registration).
 * Production: payment.momo.vn (KYC business).
 */
export { createMomoAdapter, type MomoAdapterConfig } from "./adapter.js";
export {
  buildCreateOrderCanonical,
  buildIpnCanonical,
  buildRefundCanonical,
  sign,
  verifyIpnSignature,
} from "./signature.js";

export const PAYKIT_MOMO_VERSION = "0.1.5-alpha.1";
