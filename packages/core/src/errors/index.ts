/**
 * Paykit error taxonomy. All paykit-thrown errors extend `PaykitError` with a
 * stable `code` discriminator for typed handling at HTTP boundary.
 *
 * Codes are SCREAMING_SNAKE_CASE; never depend on `error.name` being unique
 * across bundlers — use `code` instead.
 */

export class PaykitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaykitError";
    this.code = code;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class TenantResolutionError extends PaykitError {
  constructor(message: string) {
    super("TENANT_RESOLUTION_ERROR", message);
    this.name = "TenantResolutionError";
  }
}

export class DiscountResolverError extends PaykitError {
  constructor(message: string) {
    super("DISCOUNT_RESOLVER_ERROR", message);
    this.name = "DiscountResolverError";
  }
}

export class DiscountConsumeFailedError extends PaykitError {
  constructor(message: string) {
    super("DISCOUNT_CONSUME_FAILED", message);
    this.name = "DiscountConsumeFailedError";
  }
}

export class CurrencyMismatchError extends PaykitError {
  constructor(message: string) {
    super("CURRENCY_MISMATCH", message);
    this.name = "CurrencyMismatchError";
  }
}

export class UnsupportedCurrencyError extends PaykitError {
  constructor(message: string) {
    super("UNSUPPORTED_CURRENCY", message);
    this.name = "UnsupportedCurrencyError";
  }
}

export class AmountMismatchError extends PaykitError {
  constructor(message: string) {
    super("AMOUNT_MISMATCH", message);
    this.name = "AmountMismatchError";
  }
}

export class WebhookSignatureError extends PaykitError {
  constructor(message: string) {
    super("WEBHOOK_SIGNATURE_INVALID", message);
    this.name = "WebhookSignatureError";
  }
}

export class WebhookDuplicateError extends PaykitError {
  constructor(message: string) {
    super("WEBHOOK_DUPLICATE", message);
    this.name = "WebhookDuplicateError";
  }
}

export class RefundExceedsBalanceError extends PaykitError {
  constructor(message: string) {
    super("REFUND_EXCEEDS_BALANCE", message);
    this.name = "RefundExceedsBalanceError";
  }
}

export class SecretFetchError extends PaykitError {
  constructor(message: string) {
    super("SECRET_FETCH_ERROR", message);
    this.name = "SecretFetchError";
  }
}
