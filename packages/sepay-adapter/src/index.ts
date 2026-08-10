/**
 * @xeko-git-1/paykit-sepay — V1.5 adapter for SePay VietQR bank-transfer payments.
 *
 * Notable: SePay refunds are NOT API-supported (bank transfers one-way).
 * `refund()` returns state='unsupported' with pointer to /admin/billing/ledger/adjust.
 */
export { createSepayAdapter, type SepayAdapterConfig } from "./adapter.js";

export const PAYKIT_SEPAY_VERSION = "0.1.5-alpha.1";
