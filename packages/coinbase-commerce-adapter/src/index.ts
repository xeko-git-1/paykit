/**
 * @xeko-git-1/paykit-coinbase-commerce — adapter for crypto payments via
 * Coinbase Commerce.
 *
 * Flow:
 *   1. createCheckout: POST /charges with a fixed USD price → hosted checkout page
 *      (web + QR). The customer picks the coin and chain on Coinbase's page;
 *      Coinbase settles to the merchant account.
 *   2. Webhook: Coinbase POSTs `{ event: { type, data } }` with an
 *      `X-CC-Webhook-Signature` header holding hex HMAC-SHA256 of the raw body
 *      under the shared secret. verifyWebhookSignature recomputes and compares it,
 *      so authenticating a delivery needs no call back to the provider.
 *   3. parseWebhookPayload: map the event type → paykit event; providerRef comes
 *      from `metadata.paykit_transaction_id` (= paykit transactionId), which
 *      round-trips on every event for the charge.
 *   4. refund: unsupported — Coinbase Commerce has no refund endpoint. The server
 *      answers 501 and an operator refunds from the Coinbase merchant account and
 *      records it with a ledger adjustment.
 *
 * USD-only at the paykit ledger boundary; the payer's coin+chain is invisible to
 * paykit, which sees only the charge's USD price.
 *
 * NOT VERIFIED END-TO-END: built from Coinbase's published SDKs and unit-tested
 * against a local mock, with no charge ever created against a live or sandbox
 * account. See the adapter docblock for the specific fields to confirm on first
 * live use.
 */
export { type CoinbaseCommerceAdapterConfig, createCoinbaseCommerceAdapter } from "./adapter.js";
export {
  type CoinbaseCommerceCharge,
  type CoinbaseCommerceEventEnvelope,
  type CoinbaseCommerceTimelineEntry,
  mapEventTypeToWebhookEventType,
  PAYKIT_REFERENCE_METADATA_KEY,
  parseCoinbaseCommerceEvent,
} from "./webhook-events.js";
export {
  COINBASE_COMMERCE_SIGNATURE_HEADER,
  computeCoinbaseCommerceSignature,
  verifyCoinbaseCommerceSignature,
} from "./webhook-verifier.js";

export const PAYKIT_COINBASE_COMMERCE_VERSION = "0.3.0-rc.0";
