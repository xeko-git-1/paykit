-- Revert the screening handoff.
--
-- Dropping screening_jobs LOSES data: the audit trail of screening verdicts and
-- any job that has not reached a verdict yet. Only roll back when no screening
-- is in flight.

DROP TABLE IF EXISTS paykit.screening_jobs;

-- Revert the status enum to its prior set.
--
-- WARNING: any payment_transactions row still in 'screening_pending' violates
-- the restored CHECK and makes this statement fail. That is deliberate: such a
-- row is a paid, uncredited payment. Decide each one (credit -> 'completed', or
-- hold -> 'quarantine') before rolling back.
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
