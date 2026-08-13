-- Per-tenant default currency for the generic checkout amount.
--
-- The checkout API grew a currency-agnostic request style (`amount` +
-- `currency`) alongside the legacy `amountUsd`/`amountVnd` fields. A tenant
-- that transacts in one currency should not have to repeat it on every
-- request, so this table stores the default the routers fall back to when a
-- generic-style request names an amount but no currency.
--
-- Keyed by tenant_id TEXT — the same identity the ledger and payment tables
-- use — rather than by merchant_id, so embedded-mode tenants (which have no
-- merchants row) can hold a preference too.
--
-- The preference is a REQUEST default, not a wallet constraint: wallets stay
-- keyed (tenant_id, currency_code) and a tenant can still transact in any
-- currency by naming it explicitly. Nothing here affects money already stored.

CREATE TABLE IF NOT EXISTS paykit.tenant_currency_preferences (
  tenant_id TEXT PRIMARY KEY,

  -- Same ISO-4217 alpha-3 shape check as every other currency_code column
  -- (020). The application allow-list (currency registry) is enforced in code
  -- where it can be released; the shape is a permanent property of the column.
  currency_code TEXT NOT NULL
    CONSTRAINT tenant_currency_preferences_currency_code_iso4217
      CHECK (currency_code ~ '^[A-Z]{3}$'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
