// Server barrel — db schema + repos. Phases 04-07 will add provider clients,
// routes, middleware. Phase 13 adds observability + secret rotation hooks.

export type { DbClient, DbOrTx, DbTransactionHandle } from "./db/client.js";

// Schema
export {
  type ApiKey,
  apiKeys,
  type BalanceProjection,
  balanceProjections,
  type Customer,
  customers,
  type IdempotencyRecord,
  idempotencyRecords,
  type LedgerEntry,
  ledgerEntries,
  type Merchant,
  merchants,
  type NewApiKey,
  type NewBalanceProjection,
  type NewCustomer,
  type NewIdempotencyRecord,
  type NewLedgerEntry,
  type NewMerchant,
  type NewPaymentTransaction,
  type NewPendingRefund,
  type NewReconciliationRun,
  type NewRuntimeConfig,
  type NewSubscription,
  type NewSubscriptionEvent,
  type NewWebhookEvent,
  paykitSchema,
  paymentTransactions,
  type PaymentTransaction,
  type PendingRefund,
  pendingRefunds,
  pendingRefundState,
  reconciliationRuns,
  type ReconciliationRun,
  type RuntimeConfig,
  runtimeConfig,
  type Subscription,
  type SubscriptionEvent,
  subscriptionEvents,
  subscriptions,
  type WebhookEvent,
  webhookEvents,
} from "./db/schema/index.js";

// Auth primitives
export {
  hashApiKey,
  mintApiKey,
  verifyApiKey,
  type ApiKeyLookup,
  type MintApiKeyOpts,
  type MintApiKeyResult,
  type VerifyResult,
} from "./auth/api-key.js";
export {
  hasScope,
  isScopeSubset,
  SCOPES,
  type ApiKeyScope,
} from "./auth/scope.js";

// Auth middleware (V4 Phase 3)
export {
  type PaykitAuthContext,
  type AuthPlane,
  getAuthTenant,
  authTenant,
  isAuthError,
} from "./auth/auth-context.js";
export {
  apiKeyAuthMiddleware,
  type ApiKeyAuthDeps,
} from "./auth/api-key-middleware.js";
export {
  jwtAuthMiddleware,
  createJwtSecretLoader,
  type JwtAuthDeps,
  type JwtSecretLoader,
  type SecretLoaderDeps,
} from "./auth/jwt-middleware.js";
export {
  requireScope,
  requirePlane,
  type RequireScopeOpts,
} from "./auth/require-scope.js";

// Repos
export * as apiKeyRepo from "./db/repos/api-key.repo.js";
export * as balanceRepo from "./db/repos/balance.repo.js";
export * as customerRepo from "./db/repos/customer.repo.js";
export * as idempotencyRepo from "./db/repos/idempotency.repo.js";
export * as ledgerRepo from "./db/repos/ledger.repo.js";
export * as paymentRepo from "./db/repos/payment.repo.js";
export * as pendingRefundRepo from "./db/repos/pending-refund.repo.js";
export * as reconciliationRepo from "./db/repos/reconciliation.repo.js";
export * as runtimeConfigRepo from "./db/repos/runtime-config.repo.js";
export * as subscriptionRepo from "./db/repos/subscription.repo.js";
export * as subscriptionEventRepo from "./db/repos/subscription-event.repo.js";
export * as webhookEventRepo from "./db/repos/webhook-event.repo.js";

// Provider clients
export {
  createSePayClient,
  type SePayCheckoutResult,
  SePayClient,
  type SePayConfig,
  type SePayWebhookPayload,
  type CreateTopUpSessionInput,
  createStripeClient,
  type StripeCheckoutResult,
  StripeClient,
  type StripeConfig,
} from "./providers/index.js";

// V2 services + subscription routes
export {
  buildCustomerService,
  CustomerTenantMismatchError,
  type CustomerProviderPort,
  type GetOrCreateInput,
  type ProviderCustomerCreateInput,
  type ProviderCustomerCreateResult,
  type ProviderCustomerLookupResult,
} from "./services/customer-service.js";
export {
  buildAdminSubscriptionRoutes,
  buildIdempotencyMiddleware,
  buildTenantSubscriptionRoutes,
  IDEMPOTENCY_HEADER,
  parseStatusFilter,
  type SubscriptionDto,
  toDto,
} from "./routes/subscriptions/index.js";
export {
  buildSubscriptionWebhookHandler,
  type SubscriptionWebhookHandlerDeps,
} from "./routes/webhooks/subscription-webhook-handler.js";
export {
  buildAdminInvoiceRefundRoute,
  type AdminInvoiceRefundDeps,
  type InvoiceRefundClient,
} from "./routes/admin/invoice-refund-route.js";

// V3 createPaykit factory + config (Phase 0b export — needed by e2e/consumer-app harness)
export {
  createPaykit,
  type Paykit,
  type PaykitConfig,
  type PaykitLogger,
  type LegacyProvidersConfig,
} from "./server/create-paykit.js";

// Response helpers
export { errorJson, dataJson } from "./routes/shared/response.js";

// Refund core (guard-agnostic shared logic for admin + merchant planes)
export {
  executeRefund,
  type RefundActor,
  type RefundCoreInput,
  type RefundCoreDeps,
  type RefundCoreResult,
} from "./services/refund-core.js";

export const PAYKIT_SERVER_VERSION = "0.2.0-alpha.1";
