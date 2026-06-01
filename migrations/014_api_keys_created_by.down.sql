-- Down: drop the created_by attribution column.
--
-- Safe to drop — the column is nullable metadata with no FK or index dependency.
-- Rolling back loses mint attribution for keys created while it existed, but
-- does not affect key verification or any active credential.

ALTER TABLE paykit.api_keys DROP COLUMN IF EXISTS created_by;
