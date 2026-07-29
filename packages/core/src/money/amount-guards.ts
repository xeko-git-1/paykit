/**
 * Service-level counterparts to the money CHECK constraints in the database.
 *
 * The DB constraints are the last line of defence — they abort a transaction
 * with a SQLSTATE 23514 that carries no domain meaning. These guards run first
 * so the caller gets a typed `PaykitError` with the offending values, and so a
 * bad amount never reaches a partially-applied transaction.
 */

import { CurrencyMismatchError, NonPositiveAmountError } from "../errors/index.js";

/**
 * A chargeable or refundable amount must be strictly positive. Ledger entries
 * are NOT checked here: a refund entry is stored negative by design.
 *
 * @throws {NonPositiveAmountError}
 */
export function assertPositiveMicros(micros: bigint, context: string): void {
  if (micros <= 0n) {
    throw new NonPositiveAmountError(`${context}: amount must be > 0 micros, got ${micros}`);
  }
}

/**
 * Two amounts that move the same money must name the same currency. Paykit
 * wallets are keyed `(tenant_id, currency_code)`, so a mismatch does not fail
 * loudly on its own — it credits or debits a *different wallet*, which reads as
 * missing money in one currency and phantom money in another.
 *
 * @throws {CurrencyMismatchError}
 */
export function assertSameCurrency(expected: string, actual: string, context: string): void {
  if (expected !== actual) {
    throw new CurrencyMismatchError(
      `${context}: currency mismatch — expected ${expected}, got ${actual}`,
    );
  }
}
