-- Drop the webhook inbox.
--
-- webhook_events is left untouched by the up migration precisely so this rollback
-- has somewhere to land: the old dedup ledger still holds every delivery recorded
-- before the cutover, and the router can go back to reading it.
--
-- What is lost, and cannot be recovered by re-applying the migration: every
-- delivery received while the inbox was live. Their dedup rows were written here,
-- not into webhook_events, so after this rollback the old table has no record of
-- them -- a provider redelivering one of those events would be processed a second
-- time. Ledger idempotency (UNIQUE (provider, source_id, entry_type)) is what stops
-- that from double-crediting, but the event would be re-handled.
--
-- Anything sitting in unmatched/failed/dead_letter is work that was never
-- completed. Rolling back discards it silently. Drain or export those rows first.

DROP INDEX IF EXISTS paykit.paykit_webhook_inbox_transaction_idx;
DROP INDEX IF EXISTS paykit.paykit_webhook_inbox_dead_letter_idx;
DROP INDEX IF EXISTS paykit.paykit_webhook_inbox_lease_idx;
DROP INDEX IF EXISTS paykit.paykit_webhook_inbox_due_idx;

DROP TABLE IF EXISTS paykit.webhook_inbox;
