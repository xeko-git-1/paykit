DROP INDEX IF EXISTS paykit.paykit_le_provider_source_type_uq;

ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;

ALTER TABLE paykit.ledger_entries
  ADD CONSTRAINT ledger_entries_entry_type_check
    CHECK (entry_type IN ('credit','debit','refund','manual_adjustment'));

ALTER TABLE paykit.ledger_entries
  DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS provider;
