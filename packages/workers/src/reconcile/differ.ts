/**
 * Differ — classify reconciliation outcomes by joining paykit's
 * payment_transactions snapshot against provider records.
 *
 * Match key: provider_ref. For Stripe this is `session.id`; for SePay this is
 * the orderId we generated at checkout time (= paykit transactionId).
 *
 * Amount comparison uses BigInt micros (never float), and only ever between two
 * records denominated in the SAME currency — see the currency check below.
 */
import type { Discrepancy, PerProviderStats } from "./summary.js";

export interface PaykitTxnSnapshot {
  readonly transactionId: string;
  readonly providerRef: string | null;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly status: string;
}

export interface ProviderTxnRecord {
  readonly providerRef: string;
  readonly amountMicros: string; // converted to micros at fetch boundary
  readonly currencyCode: string;
  readonly refundedAmountMicros?: string; // optional, for refund_drift detection
}

export function diffPaykitVsProvider(
  provider: string,
  paykitTxns: readonly PaykitTxnSnapshot[],
  providerTxns: readonly ProviderTxnRecord[],
): { stats: PerProviderStats; discrepancies: Discrepancy[] } {
  const paykitByRef = new Map<string, PaykitTxnSnapshot>();
  for (const t of paykitTxns) {
    if (t.providerRef !== null) paykitByRef.set(t.providerRef, t);
  }
  const providerByRef = new Map<string, ProviderTxnRecord>();
  for (const p of providerTxns) providerByRef.set(p.providerRef, p);

  const discrepancies: Discrepancy[] = [];
  let matched = 0;
  let paykitMissing = 0;
  let providerMissing = 0;
  let amountMismatch = 0;
  let currencyMismatch = 0;
  let refundDrift = 0;

  // Walk provider records first — flag paykit_missing or an amount/currency
  // disagreement.
  for (const p of providerTxns) {
    const pk = paykitByRef.get(p.providerRef);
    if (!pk) {
      paykitMissing++;
      discrepancies.push({
        type: "paykit_missing",
        provider,
        transactionId: null,
        providerRef: p.providerRef,
        paykitAmountMicros: null,
        providerAmountMicros: p.amountMicros,
      });
      continue;
    }
    // Currency before amount. Two micros counts are only comparable when they
    // denominate the same thing: 9.95 USDT against a row of 9.95 USD is an
    // adapter that never normalized, not a settlement shortfall, and comparing
    // the integers reports an amount drift that may be pure coincidence in
    // either direction — a match that is not one, or a mismatch whose magnitude
    // means nothing. The codes are normalized to upper case because they arrive
    // from provider JSON in whatever case the provider felt like.
    if (pk.currencyCode.toUpperCase() !== p.currencyCode.toUpperCase()) {
      currencyMismatch++;
      discrepancies.push({
        type: "currency_mismatch",
        provider,
        transactionId: pk.transactionId,
        providerRef: p.providerRef,
        paykitAmountMicros: pk.amountMicros,
        providerAmountMicros: p.amountMicros,
        paykitCurrencyCode: pk.currencyCode,
        providerCurrencyCode: p.currencyCode,
        note: "provider reported a different currency; amounts were not compared",
      });
      continue;
    }
    if (BigInt(pk.amountMicros.split(".")[0] ?? "0") !== BigInt(p.amountMicros)) {
      amountMismatch++;
      discrepancies.push({
        type: "amount_mismatch",
        provider,
        transactionId: pk.transactionId,
        providerRef: p.providerRef,
        paykitAmountMicros: pk.amountMicros,
        providerAmountMicros: p.amountMicros,
      });
      continue;
    }
    // Refund drift: provider has refundedAmountMicros > 0 but paykit status != 'refunded'.
    if (
      p.refundedAmountMicros !== undefined &&
      BigInt(p.refundedAmountMicros) > 0n &&
      pk.status !== "refunded"
    ) {
      refundDrift++;
      discrepancies.push({
        type: "refund_drift",
        provider,
        transactionId: pk.transactionId,
        providerRef: p.providerRef,
        paykitAmountMicros: pk.amountMicros,
        providerAmountMicros: p.refundedAmountMicros,
        note: "provider shows refund but paykit status not 'refunded'",
      });
      continue;
    }
    matched++;
  }

  // Walk paykit completed/refunded txns — flag provider_missing.
  for (const t of paykitTxns) {
    if (t.providerRef === null) continue;
    if (t.status !== "completed" && t.status !== "refunded") continue;
    if (!providerByRef.has(t.providerRef)) {
      providerMissing++;
      discrepancies.push({
        type: "provider_missing",
        provider,
        transactionId: t.transactionId,
        providerRef: t.providerRef,
        paykitAmountMicros: t.amountMicros,
        providerAmountMicros: null,
      });
    }
  }

  return {
    stats: {
      matched,
      paykitMissing,
      providerMissing,
      amountMismatch,
      currencyMismatch,
      refundDrift,
    },
    discrepancies,
  };
}
