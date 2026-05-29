-- V2 Phase 06 — extend ledger_entries for subscription/refund/dispute idempotency.
--
-- Adds:
--   * source_id TEXT — Stripe object id (invoice.id / charge.id / dispute.id /
--     credit_note.id) for the ledger-defining event. NULL for V1 entries.
--   * provider TEXT — owning adapter id (e.g. 'stripe-subscription').
--   * UNIQUE (provider, source_id, entry_type) WHERE source_id IS NOT NULL —
--     blocks Stripe-resend double-credit (RT F1) without affecting V1 rows.
--
-- Extends entry_type CHECK to V2 vocabulary: subscription_credit, refund_debit,
-- dispute_debit, credit_note_debit. V1 vocabulary preserved.

ALTER TABLE paykit.ledger_entries
  ADD COLUMN provider  TEXT,
  ADD COLUMN source_id TEXT;

ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;

ALTER TABLE paykit.ledger_entries
  ADD CONSTRAINT ledger_entries_entry_type_check
    CHECK (entry_type IN (
      'credit',
      'debit',
      'refund',
      'manual_adjustment',
      'subscription_credit',
      'refund_debit',
      'dispute_debit',
      'credit_note_debit'
    ));

CREATE UNIQUE INDEX paykit_le_provider_source_type_uq
  ON paykit.ledger_entries (provider, source_id, entry_type)
  WHERE source_id IS NOT NULL;
