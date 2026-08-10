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
 * - fetchTransactions: read-only, COMPLETE listing of the window (see below)
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

  /**
   * Whether this rail can list settled transactions by date window at all.
   *
   * Set to `false` ONLY when the provider exposes no merchant-wide date-range
   * listing and settled transactions can be read one reference at a time
   * (Binance Pay: query by merchantTradeNo/prepayId only). Such an adapter still
   * implements `fetchTransactions` — it returns `[]` — but the reconciler must
   * NOT interpret that emptiness as "the provider settled nothing in this
   * window", because it is only "this adapter cannot answer the question".
   *
   * The distinction is load-bearing. An empty list from a listing-capable
   * adapter means every settled paykit row in the window is unaccounted for at
   * the provider, which is a real discrepancy worth waking someone for. The same
   * `[]` from an adapter that cannot list means nothing at all, and treating it
   * as data fabricates one bogus discrepancy per stored payment while making the
   * run read as fully reconciled — which also hides the opposite and more
   * dangerous case, money at the provider with no paykit row.
   *
   * Omitted / `true` means the adapter lists by window and its result is
   * authoritative for that window. Defaulting to capable keeps every existing
   * adapter on the path it was verified against.
   *
   * An adapter that CAN list but is currently missing the credentials to do so
   * must throw from `fetchTransactions` instead of setting this flag: that is a
   * fault to fix, not a permanent property of the rail.
   */
  readonly canListTransactions?: boolean;

  /**
   * Every settled provider transaction in `[since, until)` — the COMPLETE set,
   * not one page of it.
   *
   * The reconciler calls this ONCE per run and treats the result as the whole
   * truth about the window: a stored payment whose reference is absent from the
   * returned list is reported as missing at the provider. An implementation that
   * stops at the provider's first page therefore does not under-report, it
   * MIS-reports — it invents a discrepancy for every transaction past the page
   * boundary, and buries the genuine ones under them.
   *
   * So the implementation owns the paging: keep requesting until the provider
   * says there is no more, and return the accumulated records. `until` defaults
   * to now when the caller omits it.
   *
   * On failure, THROW. Do not swallow an error into `[]`: an empty list is a
   * factual claim that the provider settled nothing, and the reconciler believes
   * it — a run that could not reach the provider would be recorded as a clean
   * reconciliation of an empty window. A thrown error is recorded against this
   * provider and the window is left to be covered again.
   *
   * Rails that cannot list by window at all declare `canListTransactions: false`
   * rather than returning a misleading `[]`.
   */
  fetchTransactions(window: { since: Date; until?: Date }): Promise<readonly ProviderTxnRecord[]>;

  verifyReturnUrl?(query: Record<string, string>): {
    ok: boolean;
    providerRef?: string;
    metadata?: Record<string, unknown>;
  };
}
