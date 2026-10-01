/**
 * @xeko-git-1/paykit-creem — adapter for Creem.io checkout sessions.
 *
 * Notable: every session prices over ONE pre-created product via
 * `custom_price`; webhooks are HMAC-SHA256 in the creem-signature header;
 * refunds are dashboard-only (adapter reports 'unsupported', the dashboard
 * refund's webhook settles the ledger); license keys from Creem's licensing
 * feature are forwarded in checkout.completed event metadata. Not yet
 * live-verified against a Creem test-mode account.
 */
export {
  createCreemAdapter,
  PAYKIT_REFERENCE_METADATA_KEY,
  type CreemAdapterConfig,
} from "./adapter.js";
export { verifyCreemSignature } from "./webhook-verifier.js";

export const PAYKIT_CREEM_VERSION = "0.3.0-rc.0";
