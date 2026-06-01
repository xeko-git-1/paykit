-- Quarantine-by-rename rather than DROP, matching the 012 down convention, so a
-- rollback never destroys redemption history. A re-apply of the up migration
-- recreates paykit.discounts; the quarantined table can be inspected or dropped
-- manually once the rollback is confirmed safe.
ALTER TABLE paykit.discounts RENAME TO discounts_quarantine_016;
