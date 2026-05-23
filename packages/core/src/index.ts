// @vibecc/paykit — core types, errors, money helpers, secret abstractions.
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
  DiscountResolverError,
  PaykitError,
  RefundExceedsBalanceError,
  SecretFetchError,
  TenantResolutionError,
  UnsupportedCurrencyError,
  WebhookDuplicateError,
  WebhookSignatureError,
} from "./errors/index.js";

// Money helpers
export {
  microsStringToBigInt,
  microsStringToNumber,
  stripeUsdAmountToMicros,
  vndToMicros,
} from "./money/index.js";

// Secrets
export { EnvSecretProvider } from "./secrets/provider.js";
export type { SecretProvider } from "./secrets/provider.js";

export const PAYKIT_CORE_VERSION = "0.1.0-alpha.1";
