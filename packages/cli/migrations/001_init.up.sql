-- Paykit V1 — initial schema.
-- Schema name `paykit` is isolated from consumer's `public.*` tables.
-- This file is bundled with @vibecc/paykit-cli and applied by `paykit migrate up`.

CREATE SCHEMA IF NOT EXISTS paykit;

-- payment_transactions: SePay + Stripe top-up records. Pending → completed | failed | refunded | expired.
CREATE TABLE paykit.payment_transactions (
  transaction_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  owner_id         UUID NOT NULL,
  provider         TEXT NOT NULL,
  amount_micros    NUMERIC(20,6) NOT NULL,
  currency_code    TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','refunded','expired')),
  provider_ref     TEXT,
  idempotency_key  TEXT UNIQUE,
  metadata_json    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX paykit_pt_tenant_created_idx
  ON paykit.payment_transactions (tenant_id, created_at DESC);
CREATE INDEX paykit_pt_provider_ref_idx
  ON paykit.payment_transactions (provider, provider_ref);

-- ledger_entries: append-only credit/debit/refund/manual_adjustment records.
-- Multi-currency: each entry stamps its own currency_code; never mix.
CREATE TABLE paykit.ledger_entries (
  entry_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  owner_id         UUID NOT NULL,
  entry_type       TEXT NOT NULL
    CHECK (entry_type IN ('credit','debit','refund','manual_adjustment')),
  amount_micros    NUMERIC(20,6) NOT NULL,
  currency_code    TEXT NOT NULL,
  metadata_json    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX paykit_le_tenant_currency_created_idx
  ON paykit.ledger_entries (tenant_id, currency_code, created_at DESC);
CREATE INDEX paykit_le_entry_type_idx
  ON paykit.ledger_entries (entry_type);

-- balance_projections: cached current balance, PK = (tenant_id, currency_code).
-- Multi-wallet: one tenant can hold USD + VND balances side-by-side.
-- This intentionally diverges from VibeCC's broken single-PK projection.
CREATE TABLE paykit.balance_projections (
  tenant_id              UUID NOT NULL,
  currency_code          TEXT NOT NULL,
  current_balance_micros NUMERIC(20,6) NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, currency_code)
);

-- webhook_events: dedup PK ensures each provider:event_id processed once.
-- INSERT-first dedup pattern: PK conflict → silent skip inside transaction.
CREATE TABLE paykit.webhook_events (
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);

-- reconciliation_runs: audit trail for reconciliation worker invocations.
CREATE TABLE paykit.reconciliation_runs (
  run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed')),
  summary_json  JSONB
);
CREATE INDEX paykit_rr_started_idx
  ON paykit.reconciliation_runs (started_at DESC);
