-- V2 Phase 02 — paykit.customers maps (tenant_id, provider) → Stripe customer.
-- PK is compound (tenant_id, provider) so V2.1+ can co-locate Polar/etc.
-- without schema change.
--
-- provider_customer_id length CHECK 1..255 bounds Stripe `cus_*` shape (RT 15i).
-- email is captured at create-time only; mutations later live on Stripe side.

CREATE TABLE paykit.customers (
  tenant_id              UUID NOT NULL,
  provider               TEXT NOT NULL,
  provider_customer_id   TEXT NOT NULL CHECK (length(provider_customer_id) BETWEEN 1 AND 255),
  email                  TEXT,
  metadata_json          JSONB NOT NULL DEFAULT '{}'
                           CHECK (pg_column_size(metadata_json) <= 4096),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE UNIQUE INDEX paykit_customers_provider_id_idx
  ON paykit.customers (provider, provider_customer_id);
