-- Add in-flight state tracking to idempotency_records so concurrent requests
-- sharing a (tenant_id, idempotency_key) serialize correctly: the first INSERT
-- wins and runs the handler; a racing request observes state='in_flight' and is
-- rejected with 409 instead of running the mutating handler a second time.
--
-- response_status becomes nullable because an in_flight row has no response yet;
-- it is filled in when the winning request finalizes. Existing rows default to
-- 'done' so historical replay/body-mismatch behaviour is unchanged.
ALTER TABLE paykit.idempotency_records
  ADD COLUMN state TEXT NOT NULL DEFAULT 'done' CHECK (state IN ('in_flight', 'done'));

ALTER TABLE paykit.idempotency_records
  ALTER COLUMN response_status DROP NOT NULL;
