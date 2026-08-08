-- A reconciliation run can end four ways, not two.
--
-- The status column has only ever allowed 'running', 'completed' and 'failed', so
-- two distinct outcomes had nowhere to go and were both recorded as 'failed':
--
--   * A run where SOME providers reconciled and others errored. Collapsing it to
--     'failed' discards the part that succeeded, and an operator reading the run
--     log cannot tell a total outage from one flaky provider.
--   * A run that did not start because another instance held the reconciliation
--     lock. That is the lock doing its job on a multi-instance deployment, and
--     recording it as a failure means the normal state of a healthy cluster looks
--     like a stream of errors — which is how real failures stop being noticed.
--
ALTER TABLE paykit.reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_status_check;
ALTER TABLE paykit.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_status_check
    CHECK (status IN (
      'running',
      'completed',
      -- Some providers reconciled, at least one did not.
      'partial',
      -- No provider reconciled.
      'failed',
      -- Never ran: another instance held the lock. Not an error.
      'skipped'
    ));
