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
 *   4. Refund IPN: BitPay notifies the refund on its own resource, so
 *      `resolveWebhook` fetches GET /refunds/:id (merchant facade) and then the
 *      owning invoice, emitting payment.refunded with refundAmountMicros +
 *      providerRef = invoice.orderId so the ledger debit is written. Only
 *      settled refunds debit; created/pending/failed are skipped.
 *
 * The refund IPN field shapes follow BitPay's docs and are NOT sandbox-verified
 * (see refund-webhook.ts) — extraction is defensive and unknown values skip.
 *   4. Refund IPN: BitPay notifies the refund resource separately. resolveWebhook
 *      fetches GET /refunds/:id (merchant facade) plus the owning invoice, then
 *      emits payment.refunded carrying refundAmountMicros + providerRef=orderId
 *      so the server writes the ledger debit. Only settled refunds resolve;
 *      created/pending/failed skip. Refund field shapes follow BitPay's docs and
 *      are not sandbox-verified — see refund-webhook.ts.
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
  amountToMicros,
  invoiceToEvent,
  mapInvoiceStatusToEventType,
  type BitpayInvoice,
} from "./webhook-events.js";
export {
  extractRefundTriggerId,
  refundToEvent,
  resolveRefundWebhook,
  type BitpayRefund,
  type BitpayRefundResolveContext,
} from "./refund-webhook.js";

export const PAYKIT_BITPAY_VERSION = "0.3.0-rc.0";
