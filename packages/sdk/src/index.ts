/**
 * @xeko-git-1/paykit-sdk — thin, type-safe client for the Paykit /v1 API.
 *
 * Public surface: createPaykitClient + PaykitApiError + types. The api-key plane
 * only; key minting is the jwt/admin plane and is not exposed here.
 */
export { createPaykitClient } from "./client.js";
export type { PaykitClient, PaykitClientConfig } from "./client.js";
export { PaykitApiError } from "./error.js";
export type { paths } from "./generated/types.js";
