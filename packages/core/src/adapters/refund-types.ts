/**
 * Refund types — cross-provider refund contract.
 *
 * RefundState:
 * - 'completed':       provider confirmed refund finalized; ledger entry written
 * - 'pending':         provider returned PROCESSING (ZaloPay 2-step); paykit writes
 *                      pending_refunds row, reconciler polls until completed/failed
 * - 'pending_webhook': adapter REST returned a transient/async error but the
 *                      refund may still complete via async webhook (NowPayments
 *                      4xx/5xx, BitPay async). Server writes
 *                      payment_transactions.status='refund_pending_webhook' (Val
 *                      Session 2 D8); ledger write happens when webhook arrives
 *                      via appendLedgerEntryIdempotent UNIQUE protection.
 * - 'failed':          provider rejected (over-window, already-refunded, etc.); no ledger write
 * - 'unsupported':     adapter cannot refund (SePay one-way bank transfers); admin uses /admin/billing/ledger/adjust
 */
export type RefundState =
  | "completed"
  | "pending"
  | "pending_webhook"
  | "failed"
  | "unsupported";

export interface RefundInput {
  readonly transactionId: string;
  readonly amountMicros: bigint;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly providerRef?: string;
}

export interface RefundResult {
  readonly state: RefundState;
  readonly providerRefundId?: string;
  readonly error?: { readonly providerCode?: string; readonly message: string };
}
