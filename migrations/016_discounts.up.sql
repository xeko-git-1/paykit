-- Tenant-scoped promo/discount codes for the public checkout API. A code is
-- unique within a merchant (tenant) and carries a percentage. Redemption is
-- race-safe: consume increments times_redeemed only while it is below
-- max_redemptions (NULL = unlimited), so the last redemption cannot be
-- double-spent under concurrency.
CREATE TABLE paykit.discounts (
  discount_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  code             TEXT NOT NULL,
  percent          NUMERIC(5, 2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  max_redemptions  INTEGER CHECK (max_redemptions IS NULL OR max_redemptions >= 0),
  times_redeemed   INTEGER NOT NULL DEFAULT 0 CHECK (times_redeemed >= 0),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discounts_tenant_code_key UNIQUE (tenant_id, code)
);

-- Lookup path is always (tenant_id, code); the unique constraint already backs it.
CREATE INDEX IF NOT EXISTS discounts_tenant_id_idx ON paykit.discounts (tenant_id);
