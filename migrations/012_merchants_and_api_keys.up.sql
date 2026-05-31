-- V4 — merchants + api_keys tables for API-key authentication.
--
-- merchants is the root tenant entity for the V4 service. Each merchant owns
-- one or more api_keys used to authenticate requests. merchant_id serves as
-- tenantId and ownerId in the existing ledger/payment context.
--
-- api_keys stores hashed keys (sha256). The plaintext is returned once at
-- creation and never persisted. key_prefix is a short display-only fragment
-- (e.g. "pk_live_Abc1") for UI identification — not sufficient for verification.
--
-- mode (live|test) is a label only; both modes share the same ledger and tenant
-- in V4.0. Data isolation between live/test is deferred to a future version.

CREATE TABLE paykit.merchants (
  merchant_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE paykit.api_keys (
  key_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL
                  REFERENCES paykit.merchants (merchant_id)
                  ON DELETE RESTRICT,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'live'
                  CHECK (mode IN ('live', 'test')),
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for key verification lookup and merchant-scoped queries
CREATE INDEX paykit_api_keys_key_hash_idx ON paykit.api_keys (key_hash);
CREATE INDEX paykit_api_keys_merchant_id_idx ON paykit.api_keys (merchant_id);
