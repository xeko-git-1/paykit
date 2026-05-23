-- V1.5 — Add `internal_id` UUID to payment_transactions for cross-provider ID mapping.
-- ZaloPay requires `app_trans_id = YYMMDD_<id>` format which differs from paykit's
-- transaction_id UUID. Storing both: provider_ref = ZaloPay app_trans_id (for webhook
-- match), internal_id = paykit UUID (for cross-provider unification).

ALTER TABLE paykit.payment_transactions
  ADD COLUMN internal_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX paykit_pt_internal_id_idx
  ON paykit.payment_transactions (internal_id);

-- For V1 rows that pre-exist this migration, internal_id was filled by DEFAULT.
-- Future inserts must always include internal_id (DEFAULT continues to work).
