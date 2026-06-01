-- V4.0 — add api_keys.created_by for mint attribution (audit who minted a key).
--
-- Nullable TEXT: existing keys (minted before this column) have NULL created_by,
-- which is acceptable — attribution is forward-looking. New mints (CLI operator
-- or HTTP jwt-plane admin) record the acting principal.
--
-- ADD COLUMN nullable with no default is safe on a populated table: no rewrite,
-- no lock contention on existing rows, no impact on the unique key_hash index.

ALTER TABLE paykit.api_keys ADD COLUMN created_by TEXT;
