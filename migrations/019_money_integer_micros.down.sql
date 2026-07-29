-- Revert money columns to NUMERIC(20,6).
--
-- Fully reversible with no data loss: scale 6 can hold every integer value that
-- fits in 14 integer digits, and the up migration only ever stored whole micros.
--
-- One boundary case: a value with more than 14 integer digits (possible only
-- after the up migration widened the range, i.e. > 99_999_999_999_999 micros =
-- 1e8 currency units) does not fit NUMERIC(20,6) and makes this ALTER fail with
-- SQLSTATE 22003. That is the correct outcome — rounding or dropping such a row
-- would destroy money. Reconcile or archive those rows before rolling back.

ALTER TABLE paykit.pending_refunds
  ALTER COLUMN amount_micros TYPE NUMERIC(20,6);

ALTER TABLE paykit.balance_projections
  ALTER COLUMN current_balance_micros TYPE NUMERIC(20,6),
  ALTER COLUMN current_balance_micros SET DEFAULT 0;

ALTER TABLE paykit.ledger_entries
  ALTER COLUMN amount_micros TYPE NUMERIC(20,6);

ALTER TABLE paykit.payment_transactions
  ALTER COLUMN amount_micros TYPE NUMERIC(20,6);
