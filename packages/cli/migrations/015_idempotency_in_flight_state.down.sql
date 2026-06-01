-- Revert in-flight state tracking. Delete any in_flight rows first: they have a
-- NULL response_status and would violate the restored NOT NULL constraint. They
-- are transient placeholders (short TTL), so dropping them loses no durable data.
DELETE FROM paykit.idempotency_records WHERE state = 'in_flight';

ALTER TABLE paykit.idempotency_records
  ALTER COLUMN response_status SET NOT NULL;

ALTER TABLE paykit.idempotency_records
  DROP COLUMN IF EXISTS state;
