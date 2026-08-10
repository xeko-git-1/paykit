/**
 * Pass B — Ledger reconciliation (Val S4 Q2).
 *
 * Compares per-tenant Stripe net inflow (invoice.amount_paid − refund.amount −
 * dispute.amount − credit_note.amount, USD only) against paykit ledger sum
 * for the V2 adapter's entries. Flags drift but NEVER writes ledger rows
 * (append-only invariant).
 */
import type { LedgerDrift, QuarantineEntry } from "./types.js";

export interface StripeFinanceWindow {
  readonly invoicesPaidMicros: bigint;
  readonly chargeRefundsMicros: bigint;
  readonly disputesLostMicros: bigint;
  readonly creditNotesMicros: bigint;
}

export interface StripeFinancePort {
  fetchWindow(tenantCustomerId: string, since: Date, until: Date): Promise<StripeFinanceWindow>;
}

export interface PaykitLedgerWindow {
  readonly subscriptionCreditMicros: bigint;
  readonly refundDebitMicros: bigint;
  readonly disputeDebitMicros: bigint;
  readonly creditNoteDebitMicros: bigint;
}

export interface PaykitLedgerPort {
  fetchWindow(
    tenantId: string,
    providerId: string,
    since: Date,
    until: Date,
  ): Promise<PaykitLedgerWindow>;
}

export interface RunLedgerPassInput {
  readonly tenantId: string;
  readonly customerId: string;
  readonly providerId: string;
  readonly window: { since: Date; until: Date };
  readonly stripe: StripeFinancePort;
  readonly ledger: PaykitLedgerPort;
}

export interface LedgerPassOutcome {
  readonly drifts: readonly LedgerDrift[];
  readonly quarantine: readonly QuarantineEntry[];
}

export async function runLedgerPassForTenant(
  input: RunLedgerPassInput,
): Promise<LedgerPassOutcome> {
  const stripe = await input.stripe.fetchWindow(
    input.customerId,
    input.window.since,
    input.window.until,
  );
  const paykit = await input.ledger.fetchWindow(
    input.tenantId,
    input.providerId,
    input.window.since,
    input.window.until,
  );

  // Stripe-side net: invoices paid - refund - dispute lost - credit notes
  const stripeNet =
    stripe.invoicesPaidMicros -
    stripe.chargeRefundsMicros -
    stripe.disputesLostMicros -
    stripe.creditNotesMicros;

  // Paykit ledger entries: credits are positive, debits are negative (signed amounts).
  // sum equals subscription_credit + refund_debit + dispute_debit + credit_note_debit.
  const paykitNet =
    paykit.subscriptionCreditMicros +
    paykit.refundDebitMicros +
    paykit.disputeDebitMicros +
    paykit.creditNoteDebitMicros;

  const delta = paykitNet - stripeNet;
  if (delta === 0n) return { drifts: [], quarantine: [] };

  const drift: LedgerDrift = {
    tenantId: input.tenantId,
    expectedNetMicros: stripeNet.toString(),
    actualLedgerMicros: paykitNet.toString(),
    deltaMicros: delta.toString(),
  };

  const quarantine: QuarantineEntry = {
    reason: "ledger_drift",
    tenantId: input.tenantId,
    details: {
      customerId: input.customerId,
      windowSince: input.window.since.toISOString(),
      windowUntil: input.window.until.toISOString(),
      delta: delta.toString(),
    },
  };

  return { drifts: [drift], quarantine: [quarantine] };
}
