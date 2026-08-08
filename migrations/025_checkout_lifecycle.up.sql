-- Make a checkout recoverable: record the attempt before calling the provider,
-- and keep the provider's answer so a retry can be replayed.
--
-- Creating a checkout spans two systems, and the current sequence commits the
-- payment row, calls the provider, and only then writes the provider reference
-- back. Every gap in that sequence loses money or wedges the key:
--
--   * Crash after the provider call, before the reference is stored: a live
--     checkout session exists at the provider that this database cannot name. Its
--     webhook arrives with a reference that matches no row, so a payment the
--     customer completed is never credited.
--   * Retry with the same Idempotency-Key while provider_ref is still NULL: the
--     replay path requires a non-null reference, so the retry falls through to a
--     second INSERT and violates UNIQUE (tenant_id, idempotency_key) -- a 500 the
--     caller can never get past, on a key that is now permanently unusable.
--   * A retry that DOES replay gets a different response body than the original:
--     the reference is stored but the provider's URLs and expiry are not, so the
--     fields a client needs to actually send the customer to the provider are
--     missing from the replay.
--
-- Two statuses and one column close all three. The statuses make the pre-provider
-- state durable; the column keeps the provider's answer so a replay is a real
-- replay rather than a partial one.

-- 'provider_creating' is the state a checkout sits in from the moment its row
-- exists until the provider answers. A row found in it after a crash is a
-- checkout that MAY exist at the provider -- the one case that needs a reconcile
-- rather than a retry, and previously indistinguishable from a fresh 'pending'.
--
-- 'awaiting_payment' is what 'pending' has always meant in practice: the provider
-- has a session and the customer has not paid yet. Naming it separately is what
-- lets 'provider_creating' be recognised at all.
--
-- 'pending' is KEPT. Every historical row uses it, and every read path treats it
-- as awaiting payment; removing it would rewrite the meaning of existing data.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_status_check;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_status_check
    CHECK (status IN (
      'pending',
      'provider_creating',
      'awaiting_payment',
      'completed',
      'failed',
      'refunded',
      'partially_refunded',
      'expired',
      'quarantine',
      'refund_pending_webhook',
      'screening_pending'
    ));

-- The provider's checkout answer, kept whole.
--
-- It lands in its own column rather than in metadata_json because it is the
-- response a replay has to reproduce byte-for-byte, and metadata_json is rewritten
-- by other paths (discount bookkeeping, webhook annotations) that have no reason
-- to know they must preserve it. A replay reading a field another writer dropped
-- would hand the caller a checkout it cannot use.
ALTER TABLE paykit.payment_transactions
  ADD COLUMN IF NOT EXISTS checkout_result_json JSONB;

-- Finding a checkout stuck mid-creation is the reconcile query, and it has to be
-- cheap: it runs on a schedule against a table where these rows are a vanishing
-- fraction of the total. Partial, so the index holds only the rows in flight.
CREATE INDEX IF NOT EXISTS paykit_pt_provider_creating_idx
  ON paykit.payment_transactions (created_at)
  WHERE status = 'provider_creating';
