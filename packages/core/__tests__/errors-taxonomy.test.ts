import { describe, expect, it } from "vitest";
import {
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
} from "../src/errors/index.js";

const ALL_ERRORS = [
  TenantResolutionError,
  DiscountResolverError,
  DiscountConsumeFailedError,
  CurrencyMismatchError,
  UnsupportedCurrencyError,
  AmountMismatchError,
  WebhookSignatureError,
  WebhookDuplicateError,
  RefundExceedsBalanceError,
  SecretFetchError,
] as const;

describe("error taxonomy", () => {
  it("all errors extend PaykitError", () => {
    for (const Ctor of ALL_ERRORS) {
      const err = new Ctor("msg");
      expect(err).toBeInstanceOf(PaykitError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("each error has a unique typed `code` discriminator", () => {
    const codes = ALL_ERRORS.map((Ctor) => new Ctor("msg").code);
    const unique = new Set(codes);
    expect(unique.size).toBe(ALL_ERRORS.length);
  });

  it("each error preserves its `name` matching constructor", () => {
    for (const Ctor of ALL_ERRORS) {
      const err = new Ctor("msg");
      expect(err.name).toBe(Ctor.name);
    }
  });

  it("instanceof works after JSON serialization round-trip (not standard, just check stack)", () => {
    const err = new AmountMismatchError("amount drift");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("AmountMismatchError");
  });

  it("PaykitError is the base discriminator type", () => {
    const e = new TenantResolutionError("missing tenant");
    if (e instanceof PaykitError) {
      // narrow OK
      expect(e.code).toBe("TENANT_RESOLUTION_ERROR");
    } else {
      throw new Error("instanceof PaykitError failed");
    }
  });

  it("error messages are preserved in `message`", () => {
    const err = new WebhookSignatureError("bad sig from stripe");
    expect(err.message).toBe("bad sig from stripe");
  });
});
