-- Revert in-flight state tracking. Take an exclusive lock first so no
-- concurrent INSERT can land a new in_flight row (NULL response_status) in the
-- window between the DELETE and SET NOT NULL, which would abort the migration.
LOCK TABLE paykit.idempotency_records IN ACCESS EXCLUSIVE MODE;

-- Delete any in_flight rows: they have a NULL response_status and would violate
-- the restored NOT NULL constraint. They are transient placeholders (short
-- TTL), so dropping them loses no durable data.
DELETE FROM paykit.idempotency_records WHERE state = 'in_flight';

ALTER TABLE paykit.idempotency_records
  ALTER COLUMN response_status SET NOT NULL;

ALTER TABLE paykit.idempotency_records
  DROP COLUMN IF EXISTS state;
