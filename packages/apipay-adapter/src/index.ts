/**
 * @xeko-git-1/paykit-apipay — adapter for ApiPay (apipay.vn) Open Banking VND
 * bank-transfer payment links.
 *
 * Notable: ApiPay refunds are NOT API-supported (bank transfers one-way).
 * `refund()` returns state='unsupported' with pointer to /admin/billing/ledger/adjust.
 */
export { createApipayAdapter, type ApipayAdapterConfig } from "./adapter.js";

export const PAYKIT_APIPAY_VERSION = "0.1.0";
