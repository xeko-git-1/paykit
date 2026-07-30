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

/**
 * A money column value could not be read as whole micros — malformed, or
 * carrying a fractional part that would have to be truncated to be usable.
 * Truncation moves money silently, so parsing fails instead.
 */
export class InvalidMicrosError extends PaykitError {
  constructor(message: string) {
    super("INVALID_MICROS", message);
    this.name = "InvalidMicrosError";
  }
}

/**
 * An amount that must be strictly positive (a charge, a refund request) was
 * zero or negative. Ledger entries are exempt: a refund entry is negative by
 * design.
 */
export class NonPositiveAmountError extends PaykitError {
  constructor(message: string) {
    super("NON_POSITIVE_AMOUNT", message);
    this.name = "NonPositiveAmountError";
  }
}

/** A currency code is not a supported ISO-4217 alpha-3 code paykit accepts. */
export class InvalidCurrencyCodeError extends PaykitError {
  constructor(message: string) {
    super("INVALID_CURRENCY_CODE", message);
    this.name = "InvalidCurrencyCodeError";
  }
}

/**
 * Compliance screening could not reach a verdict — the screening service was
 * unreachable, timed out, or answered unusably. The payment stays unresolved
 * and the job is retried; it is never credited on an absent verdict.
 */
export class ScreeningUnavailableError extends PaykitError {
  constructor(message: string) {
    super("SCREENING_UNAVAILABLE", message);
    this.name = "ScreeningUnavailableError";
  }
}

/**
 * Compliance screening rejected the payment. Terminal for the credit path: the
 * payment is quarantined for manual review, ledger untouched.
 */
export class ScreeningRejectedError extends PaykitError {
  constructor(message: string) {
    super("SCREENING_REJECTED", message);
    this.name = "ScreeningRejectedError";
  }
}

/**
 * Compliance screening wants a human to decide. Not a rejection and not a
 * clearance: the payment is held (quarantined) and surfaced for review rather
 * than retried, because retrying cannot change the answer.
 */
export class ScreeningManualReviewRequiredError extends PaykitError {
  constructor(message: string) {
    super("SCREENING_MANUAL_REVIEW_REQUIRED", message);
    this.name = "ScreeningManualReviewRequiredError";
  }
}

/** A discount percent fell outside [0, 100], or was not a finite number. */
export class DiscountPercentOutOfRangeError extends PaykitError {
  constructor(message: string) {
    super("DISCOUNT_PERCENT_OUT_OF_RANGE", message);
    this.name = "DiscountPercentOutOfRangeError";
  }
}
