/**
 * @xeko-git-1/paykit-polar — adapter for Polar (polar.sh) fixed-price one-off
 * checkouts.
 *
 * Notable: Polar has no amount-only checkout, so the adapter prices every
 * session over ONE pre-created product via an ad-hoc `fixed` price override.
 * Webhooks follow the Standard Webhooks spec. Refunds are API-supported per
 * order (`pending` results settle via the refund.updated webhook). Not yet
 * live-verified against a Polar sandbox account.
 */
export {
  createPolarAdapter,
  PAYKIT_REFERENCE_METADATA_KEY,
  type PolarAdapterConfig,
} from "./adapter.js";
export { verifyPolarSignature } from "./webhook-verifier.js";

export const PAYKIT_POLAR_VERSION = "0.3.0-rc.0";
