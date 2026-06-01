-- Scope idempotency_key uniqueness to tenant: a key is only unique within
-- a single tenant, preventing cross-tenant lookups from leaking transaction data.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_idempotency_key_key;

ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_tenant_idem_key UNIQUE (tenant_id, idempotency_key);
