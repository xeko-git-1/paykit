-- Drop the reconciliation cursor.
--
-- Rolling back loses every stored position, so the next run restarts its window
-- from the beginning. That is correct but not free: a window large enough to need
-- paging goes back to being a window that must be finished in one invocation.
--
-- The keyset index is dropped with it. Nothing else queries payment_transactions by
-- (created_at, transaction_id), so leaving it would be an index with no reader.

DROP INDEX IF EXISTS paykit.paykit_pt_reconcile_keyset_idx;

DROP TABLE IF EXISTS paykit.reconciliation_cursors;
