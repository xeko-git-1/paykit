-- Let a reconciliation run resume instead of restarting.
--
-- The run currently selects every payment in its window in one statement, with no
-- LIMIT, and holds the whole result in memory before diffing. Two consequences,
-- both of which get worse exactly when reconciliation matters most:
--
--   * A tenant with a large window loads an unbounded row count into one process.
--     The failure mode is not a slow run, it is a run that dies -- and a dying run
--     reconciles nothing, so the discrepancy it was going to find stays unfound.
--   * A run that dies partway has no memory of how far it got. The next invocation
--     starts the same window from the beginning and dies in the same place. A
--     window that cannot be finished in one attempt can never be finished at all.
--
-- A per-provider cursor fixes the second directly and makes the first survivable:
-- progress is durable, so a run works through a large window in bounded batches
-- across as many invocations as it takes.

CREATE TABLE IF NOT EXISTS paykit.reconciliation_cursors (
  -- One cursor per provider, not one per run: the cursor describes how far this
  -- provider has been reconciled, which outlives any single invocation.
  provider TEXT PRIMARY KEY,

  -- Keyset position, as (created_at, transaction_id) of the last row processed.
  --
  -- A keyset rather than an OFFSET because rows are inserted while reconciliation
  -- runs: OFFSET 5000 means "skip the first 5000 rows as they are NOW", so a row
  -- inserted mid-run shifts the window and a payment is skipped entirely. Skipping
  -- a payment is the one thing a reconciler must never do -- it is the sole check
  -- that a payment exists on both sides.
  --
  -- Both columns are needed: created_at alone is not unique, so a batch boundary
  -- falling between two rows sharing a timestamp would either repeat or drop them.
  last_created_at TIMESTAMPTZ,
  last_transaction_id UUID,

  -- The window this cursor is a position within. A cursor is only meaningful
  -- relative to its window; when the next run asks for a different `since`, the
  -- stored position is stale and the run starts fresh rather than resuming into a
  -- window it does not belong to.
  window_since TIMESTAMPTZ,
  window_until TIMESTAMPTZ,

  -- Whether the window was finished. A run that reaches the end sets this, so the
  -- next invocation knows to start a new window rather than re-walking a completed
  -- one from its final position (which would reconcile nothing, forever).
  exhausted BOOLEAN NOT NULL DEFAULT FALSE,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A position is both columns or neither. One without the other cannot be used as
  -- a keyset, and would silently degrade to "start from the beginning" on a path
  -- that believes it is resuming.
  CONSTRAINT reconciliation_cursors_position_complete
    CHECK ((last_created_at IS NULL) = (last_transaction_id IS NULL))
);

-- The keyset scan itself. Without a matching index the paging query sorts the
-- window on every batch, which is worse than the single unbounded select it
-- replaces: the same sort, repeated once per page.
--
-- `provider` leads because every page is for one provider and the predicate always
-- fixes it -- with (created_at, transaction_id) alone the planner filters by
-- provider through a different index and then sorts, which is precisely the sort
-- this index exists to remove. The trailing two columns are in the order the query
-- orders by, so the scan reads the keyset position forward with no sort step.
CREATE INDEX IF NOT EXISTS paykit_pt_reconcile_keyset_idx
  ON paykit.payment_transactions (provider, created_at, transaction_id);
