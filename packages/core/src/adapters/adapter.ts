/**
 * PaymentProviderAdapter — V1.5 contract. Implemented by @vibecc/paykit-{stripe,
 * sepay,vnpay,momo,zalopay} packages. Server-level routes call adapter methods
 * via ProviderRegistry.
 *
 * Lifecycle expectations:
 * - createCheckout: pure (no DB writes by adapter; server creates payment_transactions row)
 * - verifyWebhookSignature: pure
 * - parseWebhookPayload: pure (returns null to skip)
 * - refund: may call provider HTTP API; idempotent via input.idempotencyKey
 * - fetchTransactions: read-only paginated provider list
 * - verifyReturnUrl (optional): pure read-only for browser-side return handler
 */
import type { CurrencyCode } from "../types/money.js";
import type { CheckoutMode, CheckoutResult, CreateCheckoutInput } from "./checkout-types.js";
import type { ProviderTxnRecord } from "./provider-txn-record.js";
import type { RefundInput, RefundResult } from "./refund-types.js";
import type { NormalizedWebhookEvent } from "./webhook-types.js";

export interface PaymentProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportedCurrencies: readonly CurrencyCode[];
  readonly checkoutMode: CheckoutMode;

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean;

  parseWebhookPayload(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedWebhookEvent | null;

  refund(input: RefundInput): Promise<RefundResult>;

  fetchTransactions(window: { since: Date; until?: Date }): Promise<readonly ProviderTxnRecord[]>;

  verifyReturnUrl?(query: Record<string, string>): {
    ok: boolean;
    providerRef?: string;
    metadata?: Record<string, unknown>;
  };
}
