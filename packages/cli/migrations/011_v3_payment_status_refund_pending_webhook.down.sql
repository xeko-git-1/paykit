-- Down: revert to migration 010 enum (drop 'refund_pending_webhook').
--
-- WARNING: Any payment_transactions rows with status='refund_pending_webhook'
-- will violate the prior CHECK; operator must reconcile/adjust them first
-- (e.g., flip to 'refunded' or 'failed' via admin tools) before running down.

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
      'quarantine'
    ));
