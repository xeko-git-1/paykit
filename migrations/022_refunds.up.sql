-- Refunds become a first-class aggregate, and a payment can be partially refunded.
--
-- Until now a refund had no identity of its own. It existed only as a negative
-- `ledger_entries` row, and "how much has been refunded" was a SUM over those
-- rows filtered by `metadata_json->>'originalTransactionId'`. Two defects follow
-- directly from that, and neither is fixable while the ledger is the only record:
--
-- 1. The webhook credit path keys the ledger row on the PAYMENT reference
--    (`source_id = provider_ref`), and the ledger's uniqueness is
--    (provider, source_id, entry_type). So the SECOND partial refund of the same
--    payment collides with the first, the insert reports "already present", and
--    the balance delta is therefore skipped — the money is never taken off the
--    wallet, while the caller sees success. Every later partial refund does the
--    same. A refund needs its own stable identity to key the ledger on.
--
-- 2. Any refund at all moves the payment to 'refunded', because there is nothing
--    to compare the refunded total against per-refund. A $1 refund on a $100
--    payment reads downstream as fully refunded.
--
-- The ledger stays exactly what it is — the wallet's event log. This table is the
-- refund's own lifecycle and identity; the ledger row remains the accounting
-- effect of one refund reaching 'succeeded'.

-- 'partially_refunded' is the state a payment sits in once some, but not all, of
-- its captured amount has been returned. Added alongside the table because the
-- distinction is only representable when per-refund amounts are known.
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

CREATE TABLE IF NOT EXISTS paykit.refunds (
  refund_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id     UUID NOT NULL
                       REFERENCES paykit.payment_transactions(transaction_id)
                       ON DELETE CASCADE,
  tenant_id          UUID NOT NULL,
  owner_id           UUID NOT NULL,
  provider           TEXT NOT NULL,
  -- The provider's own id for this refund, when it gives one. This is what a
  -- refund webhook carries, so it is how an inbound event finds its row. Nullable
  -- because it is unknown between requesting a refund and the provider accepting
  -- it, and because refunds backfilled from history may never have recorded one.
  provider_refund_id TEXT,
  -- The caller's idempotency key. Retrying a refund request with the same key
  -- must not produce a second refund.
  idempotency_key    TEXT NOT NULL,
  -- Strictly positive: the direction is carried by the ledger entry (negative),
  -- not by the refund amount. A zero or negative refund is a defect.
  amount_micros      NUMERIC(30,0) NOT NULL CHECK (amount_micros > 0),
  currency_code      TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  status             TEXT NOT NULL DEFAULT 'requested'
                       CHECK (status IN (
                         'requested',
                         'submitted',
                         'pending_webhook',
                         'succeeded',
                         'failed',
                         'rejected'
                       )),
  reason             TEXT NOT NULL DEFAULT '',
  -- Why a refund did not succeed, kept separate from `reason` (which is why it
  -- was requested). A failed provider call and a rejected request are different
  -- events and are diagnosed differently.
  failure_code       TEXT,
  failure_message    TEXT,
  -- The ledger row this refund produced, once it succeeded. Nullable for every
  -- non-succeeded status: no money has moved yet.
  ledger_entry_id    UUID,
  metadata_json      JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at       TIMESTAMPTZ,
  -- A succeeded refund must record where the money moved; anything else must not
  -- claim to have moved money. This is the invariant that keeps the derived
  -- refunded total (SUM over status='succeeded') honest.
  CONSTRAINT refunds_succeeded_has_ledger_entry
    CHECK ((status = 'succeeded') = (ledger_entry_id IS NOT NULL))
);

-- One refund per caller key per provider. This is the gate that makes a retried
-- refund request idempotent rather than a second refund.
CREATE UNIQUE INDEX IF NOT EXISTS paykit_rf_provider_idempotency_key
  ON paykit.refunds (provider, idempotency_key);

-- Maps an inbound refund webhook to its row. Partial so the many rows without a
-- provider id yet do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS paykit_rf_provider_refund_id
  ON paykit.refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

-- Refunded-total query: SUM(amount_micros) for one payment's succeeded refunds.
CREATE INDEX IF NOT EXISTS paykit_rf_transaction_status_idx
  ON paykit.refunds (transaction_id, status);

-- ---------------------------------------------------------------------------
-- Backfill. Two sources, because neither alone is complete: `pending_refunds`
-- has the reservations (including ones that never reached the ledger), and the
-- ledger has refunds from before reserve-then-reconcile existed.
-- ---------------------------------------------------------------------------

-- Source 1: reservations. State names map onto the new lifecycle; 'timed_out' is
-- a failure whose cause is worth keeping distinct, since it means the reconciler
-- gave up rather than the provider refusing.
--
-- The ledger entry is resolved BEFORE the status is chosen, in the same
-- statement. It cannot be a post-insert correction: the succeeded/ledger CHECK is
-- row-level and fires during the INSERT, so a completed reservation whose entry
-- is missing would abort the whole migration rather than fall through to a fix-up
-- UPDATE. A reservation that claims completion but has no entry to point at is
-- therefore recorded as a failure here — its money state is genuinely unknown,
-- and that is what a human needs to see.
WITH reservation AS (
  SELECT
    pr.transaction_id,
    pt.tenant_id,
    pt.owner_id,
    pr.provider,
    pr.provider_refund_id,
    pr.idempotency_key,
    pr.amount_micros,
    pr.currency_code,
    pr.state,
    pr.reason,
    pr.metadata_json,
    pr.created_at,
    pr.updated_at,
    (SELECT le.entry_id
       FROM paykit.ledger_entries le
      WHERE le.entry_type = 'refund'
        AND le.provider = pr.provider
        AND le.source_id = 'tx:' || pr.transaction_id || ':' || pr.idempotency_key
      LIMIT 1) AS entry_id
  FROM paykit.pending_refunds pr
  JOIN paykit.payment_transactions pt
    ON pt.transaction_id = pr.transaction_id
)
INSERT INTO paykit.refunds (
  transaction_id, tenant_id, owner_id, provider, provider_refund_id,
  idempotency_key, amount_micros, currency_code, status, reason,
  failure_code, failure_message, metadata_json, created_at, updated_at,
  succeeded_at, ledger_entry_id
)
SELECT
  r.transaction_id,
  r.tenant_id,
  r.owner_id,
  r.provider,
  r.provider_refund_id,
  r.idempotency_key,
  r.amount_micros,
  r.currency_code,
  CASE
    WHEN r.state = 'queued'                              THEN 'requested'
    WHEN r.state = 'processing'                           THEN 'submitted'
    WHEN r.state = 'completed' AND r.entry_id IS NOT NULL THEN 'succeeded'
    ELSE 'failed'
  END,
  r.reason,
  CASE
    WHEN r.state = 'timed_out'                        THEN 'reconcile_timeout'
    WHEN r.state = 'completed' AND r.entry_id IS NULL  THEN 'backfill_ledger_entry_missing'
    ELSE NULL
  END,
  CASE
    WHEN r.state = 'completed' AND r.entry_id IS NULL
      THEN 'Reservation was completed but no matching refund ledger entry was found during backfill'
    ELSE NULL
  END,
  r.metadata_json,
  r.created_at,
  r.updated_at,
  CASE WHEN r.state = 'completed' AND r.entry_id IS NOT NULL THEN r.updated_at ELSE NULL END,
  CASE WHEN r.state = 'completed' THEN r.entry_id ELSE NULL END
FROM reservation r
ON CONFLICT DO NOTHING;

-- Source 2: refund ledger entries with no refund row. These predate the
-- reservation table. The ledger amount is negative, so it is negated back to the
-- refund's positive amount.
INSERT INTO paykit.refunds (
  transaction_id, tenant_id, owner_id, provider, provider_refund_id,
  idempotency_key, amount_micros, currency_code, status, reason,
  metadata_json, created_at, updated_at, succeeded_at, ledger_entry_id
)
SELECT
  pt.transaction_id,
  le.tenant_id,
  le.owner_id,
  COALESCE(le.provider, pt.provider),
  le.metadata_json->>'providerRefundId',
  -- Synthesised from the entry id: unique, stable, and recognisable as not
  -- having come from a caller.
  'backfill:' || le.entry_id,
  -le.amount_micros,
  le.currency_code,
  'succeeded',
  COALESCE(le.metadata_json->>'reason', ''),
  le.metadata_json,
  le.created_at,
  le.created_at,
  le.created_at,
  le.entry_id
FROM paykit.ledger_entries le
JOIN paykit.payment_transactions pt
  ON pt.transaction_id = (le.metadata_json->>'originalTransactionId')::uuid
WHERE le.entry_type = 'refund'
  AND le.metadata_json->>'originalTransactionId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM paykit.refunds r WHERE r.ledger_entry_id = le.entry_id
  )
ON CONFLICT DO NOTHING;

-- Reclassify payments that history recorded as fully refunded but whose
-- succeeded refunds do not add up to the captured amount. Without this, rows
-- carrying the old unconditional 'refunded' keep overstating what was returned.
UPDATE paykit.payment_transactions pt
   SET status = 'partially_refunded',
       updated_at = NOW()
 WHERE pt.status = 'refunded'
   AND (
     SELECT COALESCE(SUM(r.amount_micros), 0)
       FROM paykit.refunds r
      WHERE r.transaction_id = pt.transaction_id
        AND r.status = 'succeeded'
   ) < pt.amount_micros
   AND (
     SELECT COALESCE(SUM(r.amount_micros), 0)
       FROM paykit.refunds r
      WHERE r.transaction_id = pt.transaction_id
        AND r.status = 'succeeded'
   ) > 0;
