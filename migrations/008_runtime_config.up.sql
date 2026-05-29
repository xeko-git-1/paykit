-- V2 Phase 02 — paykit.runtime_config: key-value operator toggles with TTL.
--
-- First user (Val S4 Q3): canary mode `webhook_strict_v2`.
-- Boot writes the row with expires_at = now + 24h. Phase 07 reconciler flips
-- value 'false' → 'true' on first run after expires_at elapses; null
-- expires_at means non-expiring (e.g. permanent feature flag).

CREATE TABLE paykit.runtime_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
