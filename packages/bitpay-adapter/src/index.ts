/**
 * @vibecc/paykit-bitpay — V3 adapter for crypto payments via BitPay.
 *
 * Flow:
 *   1. createCheckout: POST /invoices with USD price (POS-facade token) →
 *      returns hosted invoice `url` (web + QR fallback). Customer pays in
 *      BTC/ETH/etc; BitPay settles USD to the merchant.
 *   2. IPN: BitPay POSTs an UNSIGNED trigger to the consumer webhook. The body
 *      is not trusted. The adapter's `resolveWebhook` fetches GET /invoices/:id
 *      back from BitPay and maps the authoritative status → event type.
 *   3. refund: POST /refunds (merchant facade — ECDSA via injected
 *      `merchantSigner`); BitPay creates the refund in 'pending' and confirms
 *      asynchronously → state='pending_webhook'.
 *
 * Sandbox: test.bitpay.com. Production: bitpay.com. USD-only at the paykit
 * ledger boundary.
 */
export {
  createBitpayAdapter,
  type BitpayAdapterConfig,
  type BitpayMerchantSigner,
} from "./adapter.js";
export {
  invoiceToEvent,
  mapInvoiceStatusToEventType,
  type BitpayInvoice,
} from "./webhook-events.js";

export const PAYKIT_BITPAY_VERSION = "0.3.0-rc.0";
