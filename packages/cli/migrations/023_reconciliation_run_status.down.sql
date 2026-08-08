-- Revert the run status set.
--
-- Rows holding one of the new statuses have to be folded into the old vocabulary
-- before the CHECK is restored, or the statement fails. Both fold to 'failed',
-- which is exactly the conflation this migration removed: a partial run and a
-- skipped run become indistinguishable from a total failure again. Nothing else
-- is lost -- no data is rewritten beyond those status values.

UPDATE paykit.reconciliation_runs
   SET status = 'failed'
 WHERE status IN ('partial', 'skipped');

ALTER TABLE paykit.reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_status_check;
ALTER TABLE paykit.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed'));
