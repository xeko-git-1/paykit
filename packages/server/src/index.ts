// Server barrel — db schema + repos. Phases 04-07 will add provider clients,
// routes, middleware. Phase 13 adds observability + secret rotation hooks.

export type { DbClient, DbOrTx, DbTransactionHandle } from "@vibecc/paykit-auth-core/db/client.js";

// Full Drizzle schema namespace — pass to drizzle(pool, { schema }) so the
// relational query API (db.query.*) is available. Service mode builds its own
// client and MUST provide this; without it db.query.* is undefined at runtime.
export * as paykitDbSchema from "@vibecc/paykit-auth-core/db/schema/index.js";

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
  type NewRefund,
  type NewRuntimeConfig,
  type NewScreeningJob,
  type NewSubscription,
  type NewSubscriptionEvent,
  type NewWebhookEvent,
  paykitSchema,
  paymentTransactions,
  type PaymentStatus,
  type PaymentTransaction,
  type PendingRefund,
  pendingRefunds,
  pendingRefundState,
  reconciliationRuns,
  type ReconciliationRun,
  type ReconciliationRunStatus,
  type Refund,
  refunds,
  type RefundStatus,
  type RefundTerminalFailure,
  type RuntimeConfig,
  runtimeConfig,
  type ScreeningDecidedState,
  type ScreeningJob,
  screeningJobs,
  type ScreeningJobState,
  type Subscription,
  type SubscriptionEvent,
  subscriptionEvents,
  subscriptions,
  type WebhookEvent,
  webhookEvents,
} from "@vibecc/paykit-auth-core/db/schema/index.js";

// Auth primitives
export {
  hashApiKey,
  mintApiKey,
  verifyApiKey,
  MAX_ACTIVE_KEYS_PER_MERCHANT,
  type ApiKeyLookup,
  type MintApiKeyOpts,
  type MintApiKeyResult,
  type VerifyResult,
} from "@vibecc/paykit-auth-core/auth/api-key.js";
export {
  hasScope,
  isScopeSubset,
  SCOPES,
  type ApiKeyScope,
} from "@vibecc/paykit-auth-core/auth/scope.js";

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
export { JWT_ISSUER, JWT_AUDIENCE } from "@vibecc/paykit-auth-core/auth/jwt-claims.js";
export {
  mintAdminJwt,
  type MintAdminJwtOpts,
} from "@vibecc/paykit-auth-core/auth/mint-admin-jwt.js";
export {
  authPlaneDispatcher,
  type AuthPlaneDispatcherDeps,
} from "./auth/auth-plane-dispatcher.js";
export {
  requireScope,
  requirePlane,
  type RequireScopeOpts,
} from "./auth/require-scope.js";

// Repos
export * as apiKeyRepo from "@vibecc/paykit-auth-core/db/repos/api-key.repo.js";
export * as balanceRepo from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
export * as customerRepo from "@vibecc/paykit-auth-core/db/repos/customer.repo.js";
export * as discountRepo from "@vibecc/paykit-auth-core/db/repos/discount.repo.js";
export * as idempotencyRepo from "@vibecc/paykit-auth-core/db/repos/idempotency.repo.js";
export * as ledgerRepo from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
export * as merchantRepo from "@vibecc/paykit-auth-core/db/repos/merchant.repo.js";
export * as paymentRepo from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
export * as pendingRefundRepo from "@vibecc/paykit-auth-core/db/repos/pending-refund.repo.js";
export * as reconciliationRepo from "@vibecc/paykit-auth-core/db/repos/reconciliation.repo.js";
export * as refundRepo from "@vibecc/paykit-auth-core/db/repos/refund.repo.js";
export * as runtimeConfigRepo from "@vibecc/paykit-auth-core/db/repos/runtime-config.repo.js";
export * as screeningJobRepo from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
export * as subscriptionRepo from "@vibecc/paykit-auth-core/db/repos/subscription.repo.js";
export * as subscriptionEventRepo from "@vibecc/paykit-auth-core/db/repos/subscription-event.repo.js";
export * as webhookEventRepo from "@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js";

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

// Discount application (consumer DiscountResolver hook + in-tx consume)
export {
  applyDiscountInTx,
  resolveDiscount,
  type DiscountOutcome,
  type DiscountLogger,
} from "./routes/checkout/apply-discount.js";

// Checkout replay — what a retried Idempotency-Key gets back, and when a retry
// is allowed at all. Exported because the standalone service's /v1 checkout must
// reach the same verdict as the embedded router; two copies of this decision is
// how the two paths drifted apart in the first place.
export {
  decideReplay,
  storableCheckoutResult,
  type CheckoutResponseBody,
  type ReplayDecision,
} from "./routes/checkout/checkout-replay.js";

// Refund core (guard-agnostic shared logic for admin + merchant planes)
export {
  executeRefund,
  type RefundActor,
  type RefundCoreInput,
  type RefundCoreDeps,
  type RefundCoreResult,
} from "./services/refund-core.js";

// Compliance screening runner.
//
// The webhook drains one job after its own transaction commits, which covers the
// common case of a screening service that answers promptly. A job whose screening
// was inconclusive is retried on a backoff schedule instead, and nothing in the
// request path will come back for it — so a deployment that configures screening
// must also call `drainScreeningJobs` from a cron or worker tick, or those
// payments stay parked in `screening_pending` until someone does.
export {
  drainScreeningJobs,
  processNextScreeningJob,
  type ScreeningJobOutcome,
  type ScreeningRunnerDeps,
} from "./services/screening-runner.js";
export {
  MAX_SCREENING_ATTEMPTS,
  screeningAttemptsExhausted,
  screeningRetryDelayMs,
} from "./services/screening-backoff.js";

export const PAYKIT_SERVER_VERSION = "0.2.0-alpha.1";
