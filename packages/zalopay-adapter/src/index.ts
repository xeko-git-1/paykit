/**
 * @xeko-git-1/paykit-zalopay — V1.5 adapter for ZaloPay e-wallet.
 *
 * Notable design quirks:
 * - **TWO HMAC keys**: key1 signs create-order; key2 verifies callback (ZaloPay convention)
 * - **app_trans_id format**: `YYMMDD_<id>` enforced by ZaloPay; paykit's UUID transactionId
 *   stored in metadata.paykitTransactionId (DB column internal_id from phase 03)
 * - **2-step refund**: /v2/refund returns PROCESSING → write to pending_refunds → reconciler
 *   polls /v2/query_refund until completed/failed (V1.5 phase 10)
 *
 * Sandbox: sb-openapi.zalopay.vn (requires ZaloPay merchant register)
 * Production: openapi.zalopay.vn (KYC business)
 */
export { createZaloPayAdapter, type ZaloPayAdapterConfig } from "./adapter.js";
export {
  buildCreateCanonical,
  buildCallbackCanonical,
  buildRefundCanonical,
  buildAppTransId,
  signWithKey1,
  signWithKey2,
  verifyCallbackMac,
} from "./signature.js";

export const PAYKIT_ZALOPAY_VERSION = "0.1.5-alpha.1";
