-- Revert to global unique on idempotency_key (single-column).
-- WARNING: this down migration only succeeds if no cross-tenant duplicate
-- idempotency keys exist in the table. If duplicates were inserted after the
-- up migration, this will fail with a unique constraint violation.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_tenant_idem_key;

ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_idempotency_key_key UNIQUE (idempotency_key);
