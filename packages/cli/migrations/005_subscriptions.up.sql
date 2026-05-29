-- V2 Phase 02 — paykit.subscriptions caches Stripe Subscription state.
-- Source-of-truth is Stripe; this cache speeds tenant-side reads and feeds
-- entitlement gating without round-tripping the provider.
--
-- status is TEXT (no CHECK enum) so future Stripe additions don't crash
-- INSERT/UPDATE (RT F3). Adapter mapper validates app-side.
--
-- last_event_created (RT F9) feeds the last-write-wins UPSERT predicate.
-- UNIQUE (provider, provider_subscription_id) (RT F10) is the conflict
-- target for `INSERT ... ON CONFLICT` upserts.

CREATE TABLE paykit.subscriptions (
  subscription_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    UUID NOT NULL,
  owner_id                     UUID NOT NULL,
  provider                     TEXT NOT NULL,
  provider_subscription_id     TEXT NOT NULL,
  customer_id                  TEXT NOT NULL,
  price_id                     TEXT NOT NULL,
  status                       TEXT NOT NULL,
  currency_code                TEXT NOT NULL DEFAULT 'USD',
  current_period_end           TIMESTAMPTZ NOT NULL,
  cancel_at_period_end         BOOLEAN NOT NULL DEFAULT FALSE,
  latest_invoice_id            TEXT,
  last_event_created           TIMESTAMPTZ NOT NULL,
  metadata_json                JSONB NOT NULL DEFAULT '{}'
                                 CHECK (pg_column_size(metadata_json) <= 4096),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_subscription_id)
);

CREATE INDEX paykit_subs_tenant_status_idx
  ON paykit.subscriptions (tenant_id, status);

CREATE INDEX paykit_subs_customer_idx
  ON paykit.subscriptions (provider, customer_id);
