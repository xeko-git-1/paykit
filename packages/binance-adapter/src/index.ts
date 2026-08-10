/**
 * @xeko-git-1/paykit-binance — adapter for Binance Pay merchant payments.
 *
 * Binance Pay is OFF-CHAIN: the payer settles from their Binance wallet balance
 * and funds land in the merchant's Binance account. There is no transaction hash,
 * no chain to pin, and no confirmation depth — unlike the on-chain USDT rails
 * (Cryptomus/NowPayments), so nothing here selects a network.
 *
 * Flow:
 *   1. createCheckout: POST /binancepay/openapi/v3/order → checkoutUrl (hosted
 *      page), qrcodeLink (QR), deeplink (Binance app). prepayId is Binance's own
 *      order id and is deliberately NOT returned as providerSessionId.
 *   2. Webhook: Binance POSTs a signed notification whose `data` member is a
 *      JSON string. verifyWebhookSignature does an RSA-SHA256 verify over
 *      timestamp + "\n" + nonce + "\n" + body + "\n".
 *   3. parseWebhookPayload: bizType/bizStatus → event type; providerRef =
 *      merchantTradeNo expanded back to the paykit transactionId.
 *   4. refund: POST /binancepay/openapi/order/refund keyed on prepayId, with
 *      refundRequestId as the idempotency key.
 *
 * WEBHOOK KEY DESIGN — merchant-configured public key (synchronous verify).
 *
 * Binance publishes its webhook public key through POST
 * /binancepay/openapi/certificates, so an adapter could fetch and cache it per
 * certSerial. This adapter instead takes the key from config, because:
 *   - The contract's sync verifyWebhookSignature + parseWebhookPayload pair fits
 *     a locally-held key. The async resolveWebhook path exists for providers
 *     whose webhooks are UNSIGNED and need a fetch-back to be authenticated at
 *     all (BitPay); Binance signs its webhooks, so re-fetching adds a network
 *     dependency without adding authenticity.
 *   - A cert fetch on the webhook path puts a signed HTTP round-trip (itself
 *     needing valid clock sync, or it fails with 400003) in front of every
 *     notification. If it fails, a genuine payment is rejected and Binance burns
 *     one of its 6 retries.
 *   - Binance rotates this key rarely; `webhookPublicKey` accepts an array, so a
 *     rotation is a config change that overlaps both keys with no dropped
 *     webhooks.
 * Trade-off accepted: the merchant must call the certificate API once at setup
 * and paste `certPublic` into BINANCE_WEBHOOK_PUBLIC_KEY. The
 * BinancePay-Certificate-SN header is consequently not used to select a key —
 * every configured key is tried.
 *
 * NOT VERIFIED END-TO-END: Binance Pay has no public sandbox (a trial merchant
 * account is granted only via support), so this package is built from the
 * published specification and unit-tested against a locally generated RSA
 * keypair. Live verification is required for: USD order pricing (needs merchant
 * onboarding — otherwise orders must be priced in USDT and paykit will
 * quarantine those completions rather than credit a coin amount as dollars),
 * goodsDetails type/category codes, the refund refundStatus enum, and the exact
 * webhook `data` field types.
 */
export { createBinanceAdapter, type BinanceAdapterConfig } from "./adapter.js";
export {
  buildSignaturePayload,
  generateNonce,
  normalizePublicKey,
  readHeader,
  signRequest,
  verifyBinanceWebhookSignature,
  BINANCE_CERT_SN_HEADER,
  BINANCE_NONCE_HEADER,
  BINANCE_SIGNATURE_HEADER,
  BINANCE_TIMESTAMP_HEADER,
} from "./webhook-verifier.js";
export {
  mapBizStatusToEventType,
  parseBinanceNotification,
  type BinanceNotificationData,
  type BinanceNotificationEnvelope,
  type BinanceRefundInfo,
} from "./webhook-events.js";
export { fromMerchantTradeNo, toMerchantTradeNo } from "./merchant-trade-no.js";

export const PAYKIT_BINANCE_VERSION = "0.3.0-rc.0";
