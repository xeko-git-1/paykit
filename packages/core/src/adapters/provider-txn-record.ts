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

/**
 * Input to `adapter.queryTransaction` — single-reference status lookup for
 * rails that cannot list by window (VNPay querydr, Momo query, ZaloPay /v2/query).
 */
export interface QueryTransactionInput {
  /** The provider-side reference stored on the paykit row (vnp_TxnRef / orderId / app_trans_id). */
  readonly providerRef: string;
  /**
   * When paykit recorded the payment. Some rails need it to locate the record:
   * VNPay querydr requires vnp_TransactionDate (the original transaction's
   * create date) alongside vnp_TxnRef. Rails that key on the reference alone
   * ignore it.
   */
  readonly createdAt?: Date;
}

/**
 * Outcome of a single-reference status lookup.
 *
 * Three answers, because the reconciler treats them differently:
 * - `settled`: the provider confirms money moved — comparable record attached.
 * - `pending`: the provider knows the reference but the payment has not
 *   finalized. Not proof of settlement, so a paykit `completed` row still
 *   disagrees with the provider.
 * - `not_found`: the provider has no settled record of this reference.
 *
 * Transport/API failures must THROW, never map onto `not_found`: "the provider
 * said no" and "the provider could not be asked" are different facts, and
 * conflating them fabricates a discrepancy per unreachable row.
 */
export type ProviderTxnQueryResult =
  | { readonly status: "settled"; readonly record: ProviderTxnRecord }
  | { readonly status: "pending" }
  | { readonly status: "not_found" };
