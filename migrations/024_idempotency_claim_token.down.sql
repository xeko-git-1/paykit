-- Remove claim ownership from idempotency_records.
--
-- After this, a finalize can only guard on state = 'in_flight', which cannot
-- distinguish the request that took the claim from one that reclaimed it after
-- the in-flight TTL expired. A slow handler can once again write its response
-- into another request's claim, and a failed one can delete a live claim. Roll
-- back only when no request is in flight.

ALTER TABLE paykit.idempotency_records
  DROP COLUMN IF EXISTS claim_generation;

ALTER TABLE paykit.idempotency_records
  DROP COLUMN IF EXISTS claim_token;
