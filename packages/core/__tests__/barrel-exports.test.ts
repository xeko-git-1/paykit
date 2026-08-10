import { describe, expect, it } from "vitest";
import * as paykit from "../src/index.js";

describe("@xeko-git-1/paykit barrel exports", () => {
  it("exports money helpers", () => {
    expect(typeof paykit.microsStringToBigInt).toBe("function");
    expect(typeof paykit.microsStringToNumber).toBe("function");
    expect(typeof paykit.stripeUsdAmountToMicros).toBe("function");
    expect(typeof paykit.vndToMicros).toBe("function");
  });

  it("exports error classes", () => {
    expect(typeof paykit.PaykitError).toBe("function");
    expect(typeof paykit.TenantResolutionError).toBe("function");
    expect(typeof paykit.CurrencyMismatchError).toBe("function");
    expect(typeof paykit.UnsupportedCurrencyError).toBe("function");
    expect(typeof paykit.AmountMismatchError).toBe("function");
    expect(typeof paykit.WebhookSignatureError).toBe("function");
    expect(typeof paykit.WebhookDuplicateError).toBe("function");
    expect(typeof paykit.DiscountResolverError).toBe("function");
    expect(typeof paykit.DiscountConsumeFailedError).toBe("function");
    expect(typeof paykit.RefundExceedsBalanceError).toBe("function");
    expect(typeof paykit.SecretFetchError).toBe("function");
  });

  it("exports SecretProvider default impl", () => {
    expect(typeof paykit.EnvSecretProvider).toBe("function"); // class constructor
  });

  it("does not export internal-only helpers (defensive)", () => {
    expect((paykit as Record<string, unknown>)._internal).toBeUndefined();
  });
});
