-- Make a received webhook durable, and separate "received" from "processed".
--
-- Today paykit.webhook_events is a three-column dedup ledger with PK
-- (provider, event_id), and the router INSERTs into it as the FIRST statement of
-- the same transaction that does the business work. That single row carries two
-- meanings at once -- "we have seen this delivery" and "this delivery is done" --
-- and they are not the same thing:
--
--   * A webhook can arrive before the checkout has stored its provider_ref. The
--     router's lookup on (provider, provider_ref) finds nothing and returns
--     early. That early return still COMMITS the dedup row, the route answers
--     200, and the provider stops retrying. The redelivery that would have
--     worked is refused by the PK. Result: the customer paid, the ledger has
--     nothing, and the payment sits awaiting payment forever -- with no log, no
--     metric, and no way to replay.
--   * Every other business-reason early return has the same shape: nothing was
--     done, yet the event is permanently marked as seen.
--
-- The fix is a real inbox: record the delivery in its own transaction, then
-- process it in a second one, and let the row's state say which of those has
-- happened. An event that could not be matched becomes retryable work instead of
-- a silent success.

-- Nothing here writes payment_transactions, so no lock ordering concern; the
-- table is new and the backfill reads only webhook_events.
CREATE TABLE IF NOT EXISTS paykit.webhook_inbox (
  inbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  provider TEXT NOT NULL,
  -- The provider's own event identifier. UNIQUE with provider so a redelivery
  -- collides instead of creating a second row -- but unlike the old PK, losing
  -- that conflict does NOT mean the work is finished: the caller reads the row's
  -- state to decide. Dedup is on receipt; completion is a separate fact.
  event_id TEXT NOT NULL,

  -- Filled when the event is matched to a payment. Null while unmatched, because
  -- the tenant is not knowable from an unmatched delivery: the provider reference
  -- is the only link, and that is exactly what has not resolved yet.
  tenant_id UUID,
  matched_transaction_id UUID,

  event_type TEXT NOT NULL,
  -- The reference the event was keyed on, kept so a retry can re-attempt the
  -- match without re-parsing the payload.
  provider_ref TEXT,

  -- sha256 of the raw body. Two deliveries sharing an event_id but differing in
  -- content is a provider bug or an attack; the hash makes it detectable. Stored
  -- instead of compared against raw_payload because raw_payload is redacted and
  -- therefore no longer hashes to the same value.
  payload_hash TEXT NOT NULL,

  -- The delivery, kept for replay and audit. Redacted on the way in by the
  -- application: secrets and PII must not be durable here just because they
  -- passed through. The hash above preserves tamper detection despite that.
  raw_payload TEXT,
  -- The parsed NormalizedWebhookEvent, so a retry does not depend on the adapter
  -- parsing identically after a version change.
  normalized_payload JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- received     -> accepted, not yet processed
  -- unmatched    -> no payment row for this reference yet; retry later
  -- processing   -> claimed by a worker under a lease
  -- processed    -> the business transaction committed
  -- failed       -> processing threw; retryable until attempts run out
  -- dead_letter  -> attempts exhausted; a human decides
  state TEXT NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'unmatched', 'processing', 'processed', 'failed', 'dead_letter')),

  processing_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A worker that dies mid-processing leaves the row claimed. The lease is what
  -- lets another worker take it back rather than the event stalling forever.
  lease_expires_at TIMESTAMPTZ,

  last_error_code TEXT,
  last_error_message TEXT,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One row per delivery. This is the dedup key; the state column, not the
  -- presence of the row, says whether the work is done.
  CONSTRAINT webhook_inbox_provider_event_uq UNIQUE (provider, event_id),

  -- A processed row must name the payment it credited. Without this, a bug that
  -- marks an unmatched event processed would be indistinguishable from real work
  -- and would reintroduce exactly the silent loss this table exists to stop.
  CONSTRAINT webhook_inbox_processed_has_match
    CHECK (state <> 'processed' OR matched_transaction_id IS NOT NULL),

  -- Terminal states carry a timestamp; non-terminal ones must not, so "when did
  -- this finish" has one answer.
  CONSTRAINT webhook_inbox_processed_at_matches_state
    CHECK ((processed_at IS NOT NULL) = (state IN ('processed', 'dead_letter')))
);

-- The claim query: rows due for another attempt, oldest first. Partial, because
-- the rows a worker wants are a vanishing fraction of a table that keeps every
-- delivery ever received.
CREATE INDEX IF NOT EXISTS paykit_webhook_inbox_due_idx
  ON paykit.webhook_inbox (next_retry_at)
  WHERE state IN ('received', 'unmatched', 'failed');

-- Reclaiming a lease abandoned by a dead worker.
CREATE INDEX IF NOT EXISTS paykit_webhook_inbox_lease_idx
  ON paykit.webhook_inbox (lease_expires_at)
  WHERE state = 'processing';

-- Operator view: what is stuck and needs a human.
CREATE INDEX IF NOT EXISTS paykit_webhook_inbox_dead_letter_idx
  ON paykit.webhook_inbox (received_at)
  WHERE state = 'dead_letter';

-- Answering "what happened to this payment" without a table scan.
CREATE INDEX IF NOT EXISTS paykit_webhook_inbox_transaction_idx
  ON paykit.webhook_inbox (matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;

-- Carry the old dedup ledger across, closed.
--
-- Historical rows must not be reprocessed: each one represents a delivery the old
-- router already ran to completion (or already lost -- either way, re-running it
-- now with no payload would credit nothing and only add noise).
--
-- They cannot be 'processed', because that state requires matched_transaction_id
-- and webhook_events never recorded one. 'dead_letter' is the honest state: the
-- delivery is closed and the audit trail says plainly that nothing about it can be
-- reconstructed. Either way no worker picks them up -- the due-work index covers
-- only received/unmatched/failed -- and dedup still holds, because dedup is the
-- UNIQUE constraint, not the state.
INSERT INTO paykit.webhook_inbox (
  provider, event_id, event_type, payload_hash, normalized_payload,
  state, processing_attempts, next_retry_at, received_at, processed_at, updated_at
)
SELECT
  we.provider,
  we.event_id,
  'unknown',
  -- No raw body was ever stored, so there is nothing to hash. A sentinel keeps
  -- the column NOT NULL while being obviously not a sha256.
  'legacy:no-payload',
  '{}'::JSONB,
  'dead_letter',
  0,
  we.recorded_at,
  we.recorded_at,
  we.recorded_at,
  we.recorded_at
FROM paykit.webhook_events we
ON CONFLICT (provider, event_id) DO NOTHING;
