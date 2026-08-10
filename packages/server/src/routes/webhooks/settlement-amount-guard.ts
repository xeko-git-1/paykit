/**
 * Requested-vs-received amount enforcement for rails where the PAYER controls
 * the transferred amount.
 *
 * Bank-transfer rails (VietQR/SePay) bind an incoming transfer to a
 * transaction by the memo the payer types into their banking app. A memo match
 * therefore proves *intent*, not *amount*: the payer edits the amount field
 * freely, so a 10,000 VND transfer carrying the memo of a 500,000 VND charge
 * would otherwise credit the ledger and flip the transaction to `completed`.
 * Every downstream consumer treats `completed` as paid-in-full, so the
 * comparison has to happen at credit time — this is the only layer holding
 * BOTH amounts:
 *
 *   requested — `payment_transactions.amount_micros`, written at checkout.
 *   received  — the adapter's normalized webhook amount.
 *
 * Card / redirect / deeplink rails settle the exact requested amount by
 * construction (the provider, not the payer, owns the amount), so they opt out
 * via `settlesExactAmount` and keep their existing verified credit path.
 *
 * Money format: `amount_micros` is Postgres `numeric(20,6)` and round-trips as
 * a decimal string ("500000000000.000000"). `BigInt()` throws on that form, so
 * amounts are parsed here rather than coerced. An amount that does not parse
 * refuses the credit outright instead of degrading to zero — a guard that reads
 * a malformed amount as 0 would mark a transaction complete having credited
 * nothing, which is the failure this module exists to prevent.
 */

/** Comparison verdict. Only `credit`/`overpaid` may touch the ledger. */
export type SettlementDecision =
  | { readonly decision: "credit"; readonly creditMicros: string }
  | {
      readonly decision: "overpaid";
      readonly creditMicros: string;
      readonly requestedMicros: string;
      readonly receivedMicros: string;
      readonly overageMicros: string;
    }
  | {
      readonly decision: "underpaid";
      readonly requestedMicros: string;
      readonly receivedMicros: string;
      readonly shortfallMicros: string;
    }
  | { readonly decision: "unreadable_amount"; readonly reason: "requested" | "received" };

export interface EvaluateSettlementAmountInput {
  /**
   * `false` only for rails where the payer picks the amount. Adapters that
   * predate this contract leave the flag undefined and are treated as
   * exact-settling, so their verified credit path is unchanged.
   */
  readonly settlesExactAmount: boolean;
  /** Requested amount from the transaction row (numeric(20,6) string). */
  readonly requestedMicros: string;
  /** Received amount from the adapter's normalized event. */
  readonly receivedMicros: string;
}

/**
 * Integer-micros parse for Postgres `numeric` strings. Sub-micro fractional
 * digits are truncated: micros is the ledger's smallest unit, so anything
 * below it cannot be credited either way. Returns `null` for anything that is
 * not a plain (optionally fractional) decimal number.
 */
function parseMicros(value: string): bigint | null {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  const integerPart = value.split(".")[0] ?? "";
  if (integerPart === "" || integerPart === "-") return null;
  try {
    return BigInt(integerPart);
  } catch {
    return null;
  }
}

export function evaluateSettlementAmount(input: EvaluateSettlementAmountInput): SettlementDecision {
  // Exact-settling rails: the provider owns the amount, so there is nothing to
  // compare. Credit exactly what the adapter reported, as today.
  if (input.settlesExactAmount) {
    return { decision: "credit", creditMicros: input.receivedMicros };
  }

  const requested = parseMicros(input.requestedMicros);
  // A zero/negative requested amount means the row is corrupt or was never
  // priced — there is no baseline to compare against, so refuse rather than
  // credit an unbounded transfer.
  if (requested === null || requested <= 0n) {
    return { decision: "unreadable_amount", reason: "requested" };
  }
  const received = parseMicros(input.receivedMicros);
  if (received === null || received < 0n) {
    return { decision: "unreadable_amount", reason: "received" };
  }

  // Exact match, no tolerance band: a shortfall of one micro is still a
  // shortfall. A band would be a standing discount an attacker can always take.
  if (received < requested) {
    return {
      decision: "underpaid",
      requestedMicros: requested.toString(),
      receivedMicros: received.toString(),
      shortfallMicros: (requested - received).toString(),
    };
  }
  if (received > requested) {
    // Credit what was asked for and surface the overage for manual
    // reconciliation. Quarantining here would punish the happy path.
    return {
      decision: "overpaid",
      creditMicros: requested.toString(),
      requestedMicros: requested.toString(),
      receivedMicros: received.toString(),
      overageMicros: (received - requested).toString(),
    };
  }
  return { decision: "credit", creditMicros: input.receivedMicros };
}
