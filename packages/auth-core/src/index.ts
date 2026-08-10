/**
 * @xeko-git-1/paykit-auth-core — HTTP-free foundation shared by paykit-server and
 * paykit-cli: Drizzle schema + client types, repos, and auth primitives (API-key
 * mint/verify, scopes, JWT claims + signing + secret loader).
 *
 * No Hono / HTTP-layer dependency. The server re-exports everything here for
 * back-compat; the CLI imports from here directly so it never bundles the HTTP
 * layer (enforced by packages/core no-cross-imports test).
 */

// Drizzle client types
export type { DbClient, DbOrTx, DbTransactionHandle } from "./db/client.js";

// Full schema namespace — pass to drizzle(pool, { schema }) for the db.query.* API.
export * as paykitDbSchema from "./db/schema/index.js";

// Schema tables + row types
export * from "./db/schema/index.js";

// Repos (namespace per table)
export * as apiKeyRepo from "./db/repos/api-key.repo.js";
export * as balanceRepo from "./db/repos/balance.repo.js";
export * as customerRepo from "./db/repos/customer.repo.js";
export * as idempotencyRepo from "./db/repos/idempotency.repo.js";
export * as ledgerRepo from "./db/repos/ledger.repo.js";
export * as merchantRepo from "./db/repos/merchant.repo.js";
export * as paymentRepo from "./db/repos/payment.repo.js";
export * as pendingRefundRepo from "./db/repos/pending-refund.repo.js";
export * as reconciliationRepo from "./db/repos/reconciliation.repo.js";
export * as runtimeConfigRepo from "./db/repos/runtime-config.repo.js";
export * as subscriptionRepo from "./db/repos/subscription.repo.js";
export * as subscriptionEventRepo from "./db/repos/subscription-event.repo.js";
export * as webhookEventRepo from "./db/repos/webhook-event.repo.js";

// Auth primitives (HTTP-free)
export {
  hashApiKey,
  mintApiKey,
  verifyApiKey,
  toBase62,
  MAX_ACTIVE_KEYS_PER_MERCHANT,
  type ApiKeyLookup,
  type MintApiKeyOpts,
  type MintApiKeyResult,
  type VerifyResult,
} from "./auth/api-key.js";
export { hasScope, isScopeSubset, SCOPES, type ApiKeyScope } from "./auth/scope.js";
export { JWT_ISSUER, JWT_AUDIENCE } from "./auth/jwt-claims.js";
export { mintAdminJwt, type MintAdminJwtOpts } from "./auth/mint-admin-jwt.js";
export {
  createJwtSecretLoader,
  type JwtSecretLoader,
  type SecretLoaderDeps,
} from "./auth/jwt-secret-loader.js";
