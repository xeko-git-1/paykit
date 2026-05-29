-- V2 Phase 02 — paykit.idempotency_records: tenant-scoped Idempotency-Key replay store.
--
-- Compound PK (tenant_id, idempotency_key) prevents cross-tenant key collision
-- (RT F6). 24h TTL matches Stripe's window; expired rows treated as cache miss.
-- request_body_hash detects "same key, different body" → server returns 422
-- IDEMPOTENCY_BODY_MISMATCH instead of replaying stale response.

CREATE TABLE paykit.idempotency_records (
  tenant_id          UUID NOT NULL,
  idempotency_key    TEXT NOT NULL,
  provider           TEXT NOT NULL,
  route_path         TEXT NOT NULL,
  request_body_hash  TEXT NOT NULL,
  response_status    INTEGER NOT NULL,
  response_body_json JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE INDEX paykit_idemp_expires_idx
  ON paykit.idempotency_records (expires_at);
