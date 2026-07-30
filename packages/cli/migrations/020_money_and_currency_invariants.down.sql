-- Revert the money invariants.
--
-- Reversibility: dropping a CHECK constraint never touches data, so every
-- statement here is non-destructive and safe to re-run. Rows that violate the
-- reverted rules (a zero amount, a lowercase currency) become writable again;
-- nothing already stored is rewritten.

ALTER TABLE paykit.pending_refunds
  DROP CONSTRAINT IF EXISTS pending_refunds_currency_code_iso4217;
ALTER TABLE paykit.balance_projections
  DROP CONSTRAINT IF EXISTS balance_projections_currency_code_iso4217;
ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_currency_code_iso4217;
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_currency_code_iso4217;

ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_amount_micros_nonzero;
ALTER TABLE paykit.pending_refunds
  DROP CONSTRAINT IF EXISTS pending_refunds_amount_micros_positive;
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_amount_micros_positive;
