-- V1.5 — Rollback pending_refunds table.
DROP INDEX IF EXISTS paykit.paykit_pr_transaction_idx;
DROP INDEX IF EXISTS paykit.paykit_pr_state_polled_idx;
DROP TABLE IF EXISTS paykit.pending_refunds;
