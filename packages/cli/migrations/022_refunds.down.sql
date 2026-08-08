-- Revert the refund aggregate.
--
-- Dropping paykit.refunds LOSES data: every refund requested, submitted, failed
-- or rejected that has no ledger entry exists ONLY here. Refunds that succeeded
-- survive as ledger entries; the rest do not. Roll back only when no refund is
-- in flight.
--
-- Payments moved to 'partially_refunded' are folded back to 'refunded' first,
-- because the restored CHECK has no room for the new state. That loses the
-- distinction — which is the state this migration existed to create — so a
-- rollback overstates how much was refunded, exactly as before.

UPDATE paykit.payment_transactions
   SET status = 'refunded',
       updated_at = NOW()
 WHERE status = 'partially_refunded';

DROP TABLE IF EXISTS paykit.refunds;

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
      'refund_pending_webhook',
      'screening_pending'
    ));
