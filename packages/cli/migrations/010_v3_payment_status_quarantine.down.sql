-- Reverse 010_v3_payment_status_quarantine.up.sql.
-- Restores the V1 status CHECK without 'quarantine'. Safe re-run if no rows
-- have status='quarantine' (caller must verify before down-migrate).

ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_status_check;

ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_status_check
    CHECK (status IN ('pending','completed','failed','refunded','expired'));
