DROP TRIGGER IF EXISTS paykit_sub_events_no_update_delete ON paykit.subscription_events;
DROP FUNCTION IF EXISTS paykit.subscription_events_append_only();
DROP INDEX IF EXISTS paykit.paykit_sub_events_sub_created_idx;
DROP TABLE IF EXISTS paykit.subscription_events;
