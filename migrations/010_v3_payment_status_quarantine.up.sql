-- V3 (shipped in v0.2.1 hotfix) — extend payment_transactions.status enum with 'quarantine'.
--
-- Required by V3 Coinbase Commerce + NowPayments adapters when webhook
-- amount drift > 5 bps (RT F6) — webhook-router writes status='quarantine'
-- + emits paykit_amount_mismatch_total{provider} metric, NO ledger entry;
-- admin reconciles via /admin/billing/ledger/adjust after off-chain check.
--
-- Validation Session 1 D3 (2026-05-27): quarantine path is the safest
-- semantic for amount_mismatch — neither auto-credit (data integrity risk)
-- nor reject (legitimate slight FX drift would 401-fail provider).
--
-- Ships in v0.2.1 so the column shape is stable when V3 adapters land
-- (Validation Session 2 D5).

ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_status_check;

ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_status_check
    CHECK (status IN ('pending','completed','failed','refunded','expired','quarantine'));
