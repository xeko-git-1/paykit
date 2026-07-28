/**
 * merchantTradeNo <-> paykit transactionId mapping.
 *
 * Binance Pay constrains `merchantTradeNo` to at most 32 characters, letters
 * and digits ONLY (error 400201 rejects anything else, 400101 rejects the wrong
 * length). A paykit transactionId is a canonical UUID: 36 characters including
 * four hyphens. It therefore cannot be sent verbatim.
 *
 * Stripping the hyphens yields exactly 32 hex characters, which fits the
 * constraint and — because UUID hyphen positions are fixed at 8-4-4-4-12 — is
 * perfectly reversible. That reversibility is what keeps the webhook lookup
 * working: the server stores provider_ref = transactionId, Binance echoes the
 * compacted form as `merchantTradeNo` in every notification, and the adapter
 * expands it back to the UUID so the router's (provider, provider_ref) query
 * finds the row. Any lossy scheme (hashing, truncation) would silently break
 * that lookup and strand paid transactions as 'pending'.
 *
 * Ids that are already Binance-legal (<=32 chars, alphanumeric) pass through
 * untouched, so a consumer that supplies its own short ids still works.
 */

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 hex chars — a UUID with its hyphens removed. */
const COMPACT_UUID = /^[0-9a-f]{32}$/i;

const BINANCE_LEGAL = /^[0-9a-zA-Z]{1,32}$/;

/**
 * Encode a paykit transactionId into a Binance-legal `merchantTradeNo`.
 * Throws when the id can be neither compacted nor sent as-is, because sending
 * an illegal value would fail at Binance with 400201 after the paykit row was
 * already created.
 */
export function toMerchantTradeNo(transactionId: string): string {
  if (CANONICAL_UUID.test(transactionId)) {
    return transactionId.replace(/-/g, "");
  }
  if (BINANCE_LEGAL.test(transactionId)) {
    return transactionId;
  }
  throw new Error(
    `Binance Pay requires merchantTradeNo to be <=32 alphanumeric characters; transactionId '${transactionId}' is neither a UUID nor already legal`,
  );
}

/**
 * Decode a `merchantTradeNo` from a webhook back into the paykit transactionId
 * that the server stored as provider_ref.
 *
 * A 32-hex value is expanded to a canonical lowercase UUID. This is exact for
 * every id this adapter emits: payment_transactions.transaction_id is a Postgres
 * `uuid` column, so paykit-issued ids are always canonical UUIDs and always
 * take the compaction branch above. A consumer-supplied 32-char hex id that was
 * NOT a UUID would round-trip to a hyphenated form and miss the lookup — use
 * ids shorter than 32 chars, or containing a non-hex character, to avoid the
 * ambiguity.
 */
export function fromMerchantTradeNo(merchantTradeNo: string): string {
  if (COMPACT_UUID.test(merchantTradeNo)) {
    const hex = merchantTradeNo.toLowerCase();
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }
  return merchantTradeNo;
}
