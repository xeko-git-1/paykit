-- Revert the checkout lifecycle states and the stored provider answer.
--
-- Rows mid-flight have to be folded into the old vocabulary before the CHECK is
-- restored. Both new states become 'pending', which is what they were
-- indistinguishable from before -- so a row that was 'provider_creating' loses the
-- one signal saying a session may exist at the provider under it. Reconcile any
-- such row before rolling back.
--
-- Dropping checkout_result_json loses every stored provider answer, so a retry
-- after rollback replays only the transaction reference again, without the URLs
-- and expiry a client needs.

UPDATE paykit.payment_transactions
   SET status = 'pending',
       updated_at = NOW()
 WHERE status IN ('provider_creating', 'awaiting_payment');

DROP INDEX IF EXISTS paykit.paykit_pt_provider_creating_idx;

ALTER TABLE paykit.payment_transactions
  DROP COLUMN IF EXISTS checkout_result_json;

ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_status_check;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_status_check
    CHECK (status IN (
      'pending',
      'completed',
      'failed',
      'refunded',
      'partially_refunded',
      'expired',
      'quarantine',
      'refund_pending_webhook',
      'screening_pending'
    ));
