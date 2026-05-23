import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CheckoutMode,
  CheckoutResult,
  CreateCheckoutInput,
  CurrencyCode,
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderTxnRecord,
  RefundInput,
  RefundResult,
} from "../src/adapters/index.js";

describe("PaymentProviderAdapter interface contract (compile-time)", () => {
  it("exposes id + displayName + supportedCurrencies + checkoutMode metadata", () => {
    expectTypeOf<PaymentProviderAdapter["id"]>().toBeString();
    expectTypeOf<PaymentProviderAdapter["displayName"]>().toBeString();
    expectTypeOf<PaymentProviderAdapter["supportedCurrencies"]>().toEqualTypeOf<
      readonly CurrencyCode[]
    >();
    expectTypeOf<PaymentProviderAdapter["checkoutMode"]>().toEqualTypeOf<CheckoutMode>();
  });

  it("createCheckout takes CreateCheckoutInput → CheckoutResult", () => {
    expectTypeOf<PaymentProviderAdapter["createCheckout"]>()
      .parameter(0)
      .toEqualTypeOf<CreateCheckoutInput>();
    expectTypeOf<
      PaymentProviderAdapter["createCheckout"]
    >().returns.resolves.toEqualTypeOf<CheckoutResult>();
  });

  it("verifyWebhookSignature returns boolean", () => {
    expectTypeOf<PaymentProviderAdapter["verifyWebhookSignature"]>().returns.toBeBoolean();
  });

  it("parseWebhookPayload returns NormalizedWebhookEvent or null", () => {
    expectTypeOf<
      PaymentProviderAdapter["parseWebhookPayload"]
    >().returns.toEqualTypeOf<NormalizedWebhookEvent | null>();
  });

  it("refund takes RefundInput → RefundResult", () => {
    expectTypeOf<PaymentProviderAdapter["refund"]>().parameter(0).toEqualTypeOf<RefundInput>();
    expectTypeOf<PaymentProviderAdapter["refund"]>().returns.resolves.toEqualTypeOf<RefundResult>();
  });

  it("fetchTransactions returns ProviderTxnRecord[]", () => {
    expectTypeOf<PaymentProviderAdapter["fetchTransactions"]>().returns.resolves.toEqualTypeOf<
      readonly ProviderTxnRecord[]
    >();
  });

  it("verifyReturnUrl is optional (read-only return URL handler)", () => {
    expectTypeOf<PaymentProviderAdapter["verifyReturnUrl"]>().toMatchTypeOf<
      ((q: Record<string, string>) => unknown) | undefined
    >();
  });
});
