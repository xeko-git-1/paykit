-- Drop the provider-side payment id. Safe: it is a convenience lookup for
-- refunds (NowPayments payment_id), carries no durable financial record — the
-- ledger holds the authoritative refund entries.
ALTER TABLE paykit.payment_transactions
  DROP COLUMN IF EXISTS provider_payment_id;
