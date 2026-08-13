-- Rolling back returns the inbox to payments-only. Subscription deliveries
-- recorded here must be removed first: the restored CHECK requires every
-- processed row to name a payment transaction, which subscription rows may not,
-- and the pre-028 code would try to process any non-terminal ones as payment
-- events. The cost is that those subscription deliveries lose their retry state —
-- after rollback their durability rests on the provider's redelivery again,
-- which is exactly the pre-028 behaviour.
DELETE FROM paykit.webhook_inbox WHERE inbox_kind = 'subscription';

ALTER TABLE paykit.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_processed_has_match;
ALTER TABLE paykit.webhook_inbox
  ADD CONSTRAINT webhook_inbox_processed_has_match
    CHECK (state <> 'processed' OR matched_transaction_id IS NOT NULL);

ALTER TABLE paykit.webhook_inbox
  DROP COLUMN IF EXISTS inbox_kind;
