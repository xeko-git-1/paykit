-- Durable handoff for the compliance screening call.
--
-- The screening hook is an HTTP request to a tenant-supplied service. It used to
-- run inside the crediting transaction, immediately after SELECT ... FOR UPDATE
-- on the payment row, which meant a slow or hanging third-party endpoint held
-- both a row lock and a pooled connection for its whole duration. Under a
-- connection pool that is how a single unresponsive tenant endpoint stalls every
-- webhook, not just its own.
--
-- Moving the call out of the transaction needs somewhere for the payment to rest
-- between "webhook received" and "credited or quarantined". Without a persisted
-- state, a crash in that window leaves a paid transaction indistinguishable from
-- an unpaid one, and the provider's retry cannot tell the difference either.

-- The resting state. Terminal states already existed ('completed' on clearance,
-- 'quarantine' on rejection); this is the intermediate one.
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

-- The queue the webhook transaction writes and the screening worker reads.
--
-- UNIQUE (transaction_id) is the idempotency key. A provider that resends the
-- completion webhook, or two server instances handling a redelivery
-- concurrently, must not enqueue two screenings for one payment: the second
-- INSERT conflicts and is a no-op, and the verdict is applied exactly once by
-- the conditional status transition out of screening_pending.
CREATE TABLE IF NOT EXISTS paykit.screening_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID NOT NULL
                     REFERENCES paykit.payment_transactions(transaction_id)
                     ON DELETE CASCADE,
  tenant_id        UUID NOT NULL,
  owner_id         UUID NOT NULL,
  provider         TEXT NOT NULL,
  -- Ledger idempotency key for the eventual credit, captured here so the worker
  -- writes the same (provider, source_id, entry_type) the inline path would have.
  source_id        TEXT NOT NULL,
  -- The normalized event the screening decision is made about, so the worker
  -- does not re-parse a provider payload and a reviewer can see what was judged.
  event_json       JSONB NOT NULL DEFAULT '{}',
  -- The amount the settlement comparison decided to credit, frozen at webhook
  -- time. The verdict is applied later, and re-deriving the amount then could
  -- reach a different answer (an overpaid transfer credits the requested amount,
  -- not the received one), so the decision is carried rather than recomputed.
  credit_micros    NUMERIC(30,0) NOT NULL CHECK (credit_micros > 0),
  currency_code    TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN (
                       'pending',
                       'in_progress',
                       'cleared',
                       'rejected',
                       'manual_review'
                     )),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Backoff target. A row is claimable when next_attempt_at <= now().
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lease expiry for a claimed row: a worker that dies mid-call leaves the row
  -- 'in_progress' forever otherwise.
  lease_expires_at TIMESTAMPTZ,
  decided_at       TIMESTAMPTZ,
  -- Audit trail for the verdict. last_error_* keeps the reason a screening could
  -- not reach a verdict distinct from the reason it rejected.
  decision_reason  TEXT,
  last_error_code  TEXT,
  last_error_message TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_id)
);

-- Claim query: oldest due work first, restricted to the states a worker may pick
-- up. Partial index keeps it small once most jobs are decided.
CREATE INDEX IF NOT EXISTS paykit_sj_claimable_idx
  ON paykit.screening_jobs (next_attempt_at)
  WHERE state IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS paykit_sj_state_idx
  ON paykit.screening_jobs (state);
