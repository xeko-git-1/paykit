-- V2 Phase 02 — paykit.subscription_events: append-only audit log.
--
-- Append-only enforced TWO ways (RT 15j):
--   1. BEFORE UPDATE OR DELETE trigger raises exception
--   2. REVOKE UPDATE, DELETE FROM paykit_app role
-- Privileged purge job (e.g. GDPR erasure) runs as a different role and is
-- the only path that can delete rows.

CREATE TABLE paykit.subscription_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL,
  provider        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  raw_payload_json JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX paykit_sub_events_sub_created_idx
  ON paykit.subscription_events (subscription_id, created_at DESC);

CREATE OR REPLACE FUNCTION paykit.subscription_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'paykit.subscription_events is append-only (no % allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paykit_sub_events_no_update_delete
  BEFORE UPDATE OR DELETE ON paykit.subscription_events
  FOR EACH ROW EXECUTE FUNCTION paykit.subscription_events_append_only();

-- App role MUST NOT update or delete. Role may not exist in dev; tolerate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paykit_app') THEN
    REVOKE UPDATE, DELETE ON paykit.subscription_events FROM paykit_app;
  END IF;
END
$$;
