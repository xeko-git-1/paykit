-- Revert the money invariants and the screening handoff.
--
-- Reversibility: dropping a CHECK constraint never touches data, so the amount
-- and currency reverts are non-destructive. Dropping screening_jobs DOES lose
-- data — the audit trail of screening verdicts and any not-yet-decided job.
-- Only roll back when no screening is in flight; a payment left in
-- 'screening_pending' has to be reconciled first (see the status revert below).

DROP TABLE IF EXISTS paykit.screening_jobs;

-- Revert the status enum to its prior set.
--
-- WARNING: any payment_transactions row still in 'screening_pending' violates
-- the restored CHECK and makes this statement fail. That is deliberate: such a
-- row is a paid, uncredited payment. Decide each one (credit → 'completed', or
-- hold → 'quarantine') before rolling back.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_status_check;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_status_check
    CHECK (status IN (
      'pending',
      'completed',
      'failed',
      'refunded',
      'expired',
      'quarantine',
      'refund_pending_webhook'
    ));

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
