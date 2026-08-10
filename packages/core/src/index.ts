// @xeko-git-1/paykit — core types, errors, money helpers, secret abstractions.
// Zero runtime deps. Foundation for server, workers, react, cli packages.

// Types
export type {
  AdminGuard,
  AdminGuardResult,
  AppliedDiscount,
  CurrencyCode,
  DbTransaction,
  DiscountResolver,
  MicrosString,
  ResolvedTenant,
  TenantResolver,
} from "./types/index.js";

// Errors
export {
  AmountMismatchError,
  CurrencyMismatchError,
  DiscountConsumeFailedError,
  DiscountPercentOutOfRangeError,
  DiscountResolverError,
  InvalidCurrencyCodeError,
  InvalidMicrosError,
  NonPositiveAmountError,
  PaykitError,
  RefundExceedsBalanceError,
  ScreeningRejectedError,
  ScreeningUnavailableError,
  SecretFetchError,
  TenantResolutionError,
  UnsupportedCurrencyError,
  WebhookDuplicateError,
  WebhookSignatureError,
} from "./errors/index.js";

// Money helpers
export {
  assertPositiveMicros,
  assertSameCurrency,
  assertSupportedCurrencyCode,
  formatMicros,
  isSupportedCurrencyCode,
  microsStringToBigInt,
  microsStringToNumber,
  parseMicros,
  stripeUsdAmountToMicros,
  SUPPORTED_CURRENCY_CODES,
  usdToMicros,
  vndToMicros,
} from "./money/index.js";

// Refund-derived payment status — one comparison, shared by every write path
export type { RefundedPaymentStatus } from "./payments/index.js";
export { isRefundableStatus, refundedPaymentStatus } from "./payments/index.js";

// Compliance screening contract
export type {
  OnBeforeCreditHook,
  ScreeningDecision,
  ScreeningRequest,
  ScreeningService,
} from "./compliance/index.js";
export { screeningServiceFromOnBeforeCredit } from "./compliance/index.js";

// Secrets
export { EnvSecretProvider } from "./secrets/provider.js";
export type { SecretProvider } from "./secrets/provider.js";
export {
  defaultRotationConfig,
  type RotationCacheEntry,
  type RotationGraceConfig,
  resolveSecretsForVerify,
} from "./secrets/rotation.js";

// Observability (Phase 13)
export {
  getMetricsText,
  incrementCounter,
  PAYKIT_METRICS,
  resetMetrics,
} from "./observability/metrics.js";
export { redactObject, redactString } from "./observability/redaction.js";
export {
  type SloConfig,
  type SloSample,
  type SloSnapshot,
  SloTracker,
} from "./observability/slo.js";

// Adapter contract (V1.5)
export type {
  CheckoutMode,
  CheckoutResult,
  CreateCheckoutInput,
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderTxnRecord,
  RefundInput,
  RefundResult,
  RefundState,
  WebhookEventType,
} from "./adapters/index.js";
export { ProviderRegistry } from "./adapters/index.js";

// Crypto coin/chain code allow-list — boot-time guard against a config typo
// that would otherwise fail at every checkout instead of at startup.
export type { CheckChainCodesInput, UnknownChainCode } from "./adapters/index.js";
export {
  CRYPTOMUS_CURRENCIES,
  CRYPTOMUS_NETWORKS,
  describeUnknownChainCodes,
  findUnknownChainCodes,
  isKnownCryptomusCurrency,
  isKnownCryptomusNetwork,
  isKnownNowpaymentsPayCurrency,
  NOWPAYMENTS_PAY_CURRENCIES,
} from "./adapters/index.js";

// Subscription contract (V2)
export type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  NormalizedSubscriptionEvent,
  SubscriptionAdapter,
  SubscriptionEventType,
  SubscriptionResult,
  SubscriptionStatus,
  UpgradeSubscriptionInput,
} from "./subscriptions/index.js";

// Retry scheduling (shared by the screening queue and the webhook inbox)
export type { BackoffOptions } from "./retry/backoff-schedule.js";
export { backoffDelayMs, nextAttemptAt } from "./retry/backoff-schedule.js";

export const PAYKIT_CORE_VERSION = "0.2.0-alpha.1";
