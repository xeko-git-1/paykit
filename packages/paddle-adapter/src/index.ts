/**
 * @xeko-git-1/paykit-paddle — adapter for Paddle Billing one-off transactions.
 *
 * Notable: prices are inline (non-catalog) so nothing is pre-created in
 * Paddle's catalog; the checkout URL requires the account's approved default
 * payment link (a merchant page embedding Paddle.js — Paddle does not host
 * the page); refunds go through the adjustments API and are approved by
 * Paddle as merchant of record, so they resolve via the adjustment.updated
 * webhook. Not yet live-verified against a Paddle sandbox account.
 */
export {
  createPaddleAdapter,
  PAYKIT_REFERENCE_CUSTOM_DATA_KEY,
  type PaddleAdapterConfig,
} from "./adapter.js";
export { verifyPaddleSignature } from "./webhook-verifier.js";

export const PAYKIT_PADDLE_VERSION = "0.3.0-rc.0";
