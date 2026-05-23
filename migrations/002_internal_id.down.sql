-- V1.5 — Rollback internal_id column.
DROP INDEX IF EXISTS paykit.paykit_pt_internal_id_idx;
ALTER TABLE paykit.payment_transactions DROP COLUMN IF EXISTS internal_id;
