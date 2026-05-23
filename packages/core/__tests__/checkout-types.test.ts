import { describe, expectTypeOf, it } from "vitest";
import type { CheckoutMode, CheckoutResult, CreateCheckoutInput } from "../src/adapters/index.js";

describe("CheckoutMode literal union", () => {
  it("is exactly 'redirect' | 'qr' | 'deeplink'", () => {
    expectTypeOf<CheckoutMode>().toEqualTypeOf<"redirect" | "qr" | "deeplink">();
  });
});

describe("CreateCheckoutInput shape", () => {
  it("requires transactionId, tenantId, ownerId, amountMicros, currencyCode", () => {
    expectTypeOf<CreateCheckoutInput>().toMatchTypeOf<{
      readonly transactionId: string;
      readonly tenantId: string;
      readonly ownerId: string;
      readonly amountMicros: bigint;
      readonly currencyCode: string;
    }>();
  });

  it("supports optional returnUrl, ipnUrl, customerEmail, orderInfo", () => {
    expectTypeOf<CreateCheckoutInput>().toMatchTypeOf<{
      readonly returnUrl?: string;
      readonly ipnUrl?: string;
      readonly customerEmail?: string;
      readonly orderInfo?: string;
    }>();
  });
});

describe("CheckoutResult shape", () => {
  it("requires webUrl + expiresAt; mobileDeeplink + qrUrl optional", () => {
    expectTypeOf<CheckoutResult>().toMatchTypeOf<{
      readonly webUrl: string;
      readonly expiresAt: Date;
      readonly mobileDeeplink?: string;
      readonly qrUrl?: string;
    }>();
  });
});
