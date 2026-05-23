-- V1.5 — pending_refunds table for ZaloPay 2-step refund (PROCESSING state).
-- Refund states:
--   queued    : just submitted to provider, awaiting first response
--   processing: provider returned PROCESSING (e.g., ZaloPay return_code=3); reconciler polls
--   completed : provider confirmed; ledger entry already written, this row archived
--   failed    : provider confirmed failure (over-window, already-refunded, etc.); no ledger
--   timed_out : reconciler couldn't get final state in 24h window; admin attention needed

CREATE TABLE paykit.pending_refunds (
  pending_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id       UUID NOT NULL REFERENCES paykit.payment_transactions(transaction_id),
  provider             TEXT NOT NULL,
  provider_refund_id   TEXT,
  idempotency_key      TEXT NOT NULL,
  amount_micros        NUMERIC(20,6) NOT NULL,
  currency_code        TEXT NOT NULL,
  reason               TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','processing','completed','failed','timed_out')),
  poll_attempts        INTEGER NOT NULL DEFAULT 0,
  last_polled_at       TIMESTAMPTZ,
  metadata_json        JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, idempotency_key)
);

CREATE INDEX paykit_pr_state_polled_idx
  ON paykit.pending_refunds (state, last_polled_at NULLS FIRST)
  WHERE state IN ('queued','processing');

CREATE INDEX paykit_pr_transaction_idx
  ON paykit.pending_refunds (transaction_id, created_at DESC);
