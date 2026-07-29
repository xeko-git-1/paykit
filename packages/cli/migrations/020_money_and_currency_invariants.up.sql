-- Database-level money invariants.
--
-- Until now nothing stopped a zero or negative charge, a refund reservation for
-- a negative amount, or a currency_code that no adapter and no wallet reader
-- understands. Each of those is a defect that only shows up as missing money:
-- wallets are keyed (tenant_id, currency_code), so a bad currency credits a
-- wallet nobody reads rather than raising anything.
--
-- The service layer checks the same rules first and raises typed errors with the
-- offending values; these constraints are the backstop for any write path that
-- bypasses it (admin SQL, a future repo, a partially updated deployment).
--
-- NOT VALID is deliberately NOT used: the constraints must hold for existing
-- rows too, and a pre-existing violation is something an operator has to see.

-- payment_transactions: a charge is strictly positive. A zero-amount payment is
-- not a payment, and a negative one is a refund wearing the wrong table.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_amount_micros_positive;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_amount_micros_positive
    CHECK (amount_micros > 0);

-- pending_refunds: a refund reservation is strictly positive. The reservation
-- amount is subtracted from refundable headroom, so a negative one would ADD
-- headroom and let the total refunded exceed what was captured.
ALTER TABLE paykit.pending_refunds
  DROP CONSTRAINT IF EXISTS pending_refunds_amount_micros_positive;
ALTER TABLE paykit.pending_refunds
  ADD CONSTRAINT pending_refunds_amount_micros_positive
    CHECK (amount_micros > 0);

-- ledger_entries: any nonzero move. Refunds and debits are stored negative, so
-- this cannot be a > 0 check — but a zero-amount entry is always meaningless and
-- consumes a (provider, source_id, entry_type) slot that a real entry needs.
ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_amount_micros_nonzero;
ALTER TABLE paykit.ledger_entries
  ADD CONSTRAINT ledger_entries_amount_micros_nonzero
    CHECK (amount_micros <> 0);

-- Currency codes: ISO-4217 alpha-3 shape on every table that keys money by
-- currency. The shape check is intentionally broader than the application's
-- allow-list (USD, VND): the allow-list changes with adapter support and lives
-- in code where it can be released, while the shape is a permanent property of
-- the column. A lowercase or 4-letter code is the failure that actually happens
-- (provider payloads echo 'usd'), and it silently forks the wallet key.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_currency_code_iso4217;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_currency_code_iso4217;
ALTER TABLE paykit.ledger_entries
  ADD CONSTRAINT ledger_entries_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

ALTER TABLE paykit.balance_projections
  DROP CONSTRAINT IF EXISTS balance_projections_currency_code_iso4217;
ALTER TABLE paykit.balance_projections
  ADD CONSTRAINT balance_projections_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

ALTER TABLE paykit.pending_refunds
  DROP CONSTRAINT IF EXISTS pending_refunds_currency_code_iso4217;
ALTER TABLE paykit.pending_refunds
  ADD CONSTRAINT pending_refunds_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

-- payment_transactions.status gains the state a payment sits in while an
-- external compliance screening runs. The screening call is an HTTP request to a
-- tenant-supplied service; it must not run inside the crediting transaction, so
-- the payment needs a durable resting place between "webhook received" and
-- "credited or quarantined". Without a persisted state, a crash between the two
-- leaves a paid transaction indistinguishable from an unpaid one.
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

-- Screening jobs: the durable handoff between the webhook transaction and the
-- worker that calls the screening service.
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
  provider         TEXT NOT NULL,
  -- The normalized event the screening decision is made about, so the worker
  -- does not re-parse a provider payload and a reviewer can see what was judged.
  event_json       JSONB NOT NULL DEFAULT '{}',
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
