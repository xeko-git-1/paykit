/**
 * PaymentProviderAdapter — V1.5 contract. Implemented by @xeko-git-1/paykit-{stripe,
 * sepay,vnpay,momo,zalopay} packages. Server-level routes call adapter methods
 * via ProviderRegistry.
 *
 * Lifecycle expectations:
 * - createCheckout: pure (no DB writes by adapter; server creates payment_transactions row)
 * - verifyWebhookSignature: pure
 * - parseWebhookPayload: pure (returns null to skip)
 * - resolveWebhook (optional): async authoritative resolution for providers that
 *   do NOT sign their webhooks (e.g. BitPay). The provider's IPN is only a
 *   trigger; the adapter calls back to the provider API to fetch the real status
 *   ("fetch-back" verification). When present, the server uses this INSTEAD of the
 *   sync verifyWebhookSignature + parseWebhookPayload pair. Returns null to skip
 *   (unrecognised/unauthentic/non-crediting event). Adapters whose webhooks ARE
 *   signed leave this undefined and keep the sync path.
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

  /**
   * Whether the rail guarantees the settled amount equals the requested amount.
   *
   * `false` for rails where the PAYER types the amount and the transaction is
   * matched by memo/reference (bank transfer: SePay/VietQR) — a memo match
   * proves intent, not amount, so the server compares requested vs received
   * before crediting and routes a shortfall to `payment.underpaid` instead of
   * `completed`.
   *
   * Omitted / `true` for provider-controlled rails (card, redirect, deeplink)
   * where the amount is fixed at checkout and cannot drift. Defaulting to
   * exact-settling keeps existing adapters on their verified credit path.
   */
  readonly settlesExactAmount?: boolean;

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean;

  parseWebhookPayload(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedWebhookEvent | null;

  /**
   * Optional async webhook resolution for unsigned-webhook providers (BitPay).
   * When defined, the server awaits this and ignores verifyWebhookSignature +
   * parseWebhookPayload. The adapter is responsible for authenticating the event
   * itself (typically by re-fetching authoritative status from the provider API).
   * Resolve to null to skip (unauthentic / non-crediting / unrecognised).
   */
  resolveWebhook?(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<NormalizedWebhookEvent | null>;

  refund(input: RefundInput): Promise<RefundResult>;

  fetchTransactions(window: { since: Date; until?: Date }): Promise<readonly ProviderTxnRecord[]>;

  verifyReturnUrl?(query: Record<string, string>): {
    ok: boolean;
    providerRef?: string;
    metadata?: Record<string, unknown>;
  };
}
