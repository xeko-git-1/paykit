-- Give an idempotency claim an owner, so a finalize can prove it still holds one.
--
-- The claim is currently identified only by (tenant_id, idempotency_key) plus
-- state = 'in_flight', and that is not enough to tell two claimants apart:
--
--   1. Request A claims the key and starts its handler.
--   2. A's handler outlives the 120s in-flight TTL.
--   3. Request B finds the row expired, reclaims it -- same primary key, same
--      state, B's own body hash -- and starts ITS handler.
--   4. A finishes and finalizes. The guard `state = 'in_flight'` matches B's row,
--      so A writes ITS response into B's claim.
--
-- A caller polling that key then reads A's response as the outcome of B's
-- request. With a checkout, that means being handed a payment session that was
-- created for a different request. The release path has the same shape: A's
-- rollback deletes B's live claim, and a third request re-runs the mutation.
--
-- A claim token makes ownership explicit. It is regenerated on every claim and
-- every reclaim, so a stale claimant's guard matches nothing and it learns the
-- claim was lost instead of silently overwriting.
--
-- claim_generation is not the guard -- the token is. It is a monotonic count of
-- how many times a key has been claimed, kept because it answers "was this key
-- reclaimed, and how often?" during an incident, which the token alone cannot.

ALTER TABLE paykit.idempotency_records
  ADD COLUMN IF NOT EXISTS claim_token UUID;

ALTER TABLE paykit.idempotency_records
  ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0;

-- Existing rows get a token so the column is uniform. Historical rows are 'done'
-- and never finalized again, so the value only has to be present, not meaningful.
UPDATE paykit.idempotency_records
   SET claim_token = gen_random_uuid()
 WHERE claim_token IS NULL;

ALTER TABLE paykit.idempotency_records
  ALTER COLUMN claim_token SET NOT NULL;

ALTER TABLE paykit.idempotency_records
  ALTER COLUMN claim_token SET DEFAULT gen_random_uuid();
