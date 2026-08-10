/**
 * ProviderTxnRecord — opaque transaction record returned by adapter.fetchTransactions
 * for reconciliation. Same shape lived in @xeko-git-1/paykit-workers V1; promoted to
 * @xeko-git-1/paykit core in V1.5 because reconciler is now registry-based.
 */
export interface ProviderTxnRecord {
  readonly providerRef: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly refundedAmountMicros?: string;
}
