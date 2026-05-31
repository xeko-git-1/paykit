-- Down: quarantine merchants + api_keys tables instead of dropping.
--
-- Renaming preserves live data so a rollback does not destroy active API keys
-- (which would cause mass 401 errors with no recovery path). The quarantined
-- tables can be re-promoted manually if the migration is re-applied later.
--
-- To fully remove quarantined data after confirming no rollback is needed,
-- drop the *_quarantine_reverted tables manually via psql.

-- Drop indexes first (they reference the original table names)
DROP INDEX IF EXISTS paykit.paykit_api_keys_key_hash_idx;
DROP INDEX IF EXISTS paykit.paykit_api_keys_merchant_id_idx;

-- Rename tables to quarantine (preserves data for manual recovery)
ALTER TABLE paykit.api_keys RENAME TO api_keys_quarantine_reverted;
ALTER TABLE paykit.merchants RENAME TO merchants_quarantine_reverted;
