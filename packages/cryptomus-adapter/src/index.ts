/**
 * @vibecc/paykit-cryptomus — adapter for crypto payments via Cryptomus.
 *
 * Flow:
 *   1. createCheckout: POST /v1/payment with a USD amount → hosted pay page
 *      (web + QR). Customer pays multi-chain USDT (BEP20/TRC20/ERC20/Polygon,
 *      etc.) or the merchant pins a coin+network; Cryptomus settles to the
 *      merchant balance.
 *   2. Webhook: Cryptomus POSTs JSON whose `sign` field is
 *      MD5( base64(body-without-sign) + PAYMENT_API_KEY ). verifyWebhookSignature
 *      recomputes it (PHP-compatible slash escaping) and compares.
 *   3. parseWebhookPayload: map status → event type; providerRef = order_id
 *      (= paykit transactionId), which round-trips cleanly in every webhook.
 *   4. refund: POST /v1/payment/refund — async; returns state='pending_webhook'
 *      until the refund_paid webhook fires, when the ledger debit is written via
 *      UNIQUE-protected appendLedgerEntryIdempotent.
 *
 * USD-only at the paykit ledger boundary; the payer's coin+chain is invisible
 * to paykit (Cryptomus reports settlement in USD).
 */
export { createCryptomusAdapter, type CryptomusAdapterConfig } from "./adapter.js";
export {
  computeCryptomusSign,
  computeCryptomusSignature,
  verifyCryptomusSignature,
  phpJsonEncode,
  CRYPTOMUS_SIGNATURE_HEADER,
} from "./webhook-verifier.js";
export {
  mapStatusToEventType,
  parseCryptomusWebhook,
  type CryptomusWebhookPayload,
} from "./webhook-events.js";

export const PAYKIT_CRYPTOMUS_VERSION = "0.3.0-rc.0";
