-- Let the webhook inbox carry subscription deliveries, not only payment ones.
--
-- The subscription webhook pipeline still authenticates a delivery and then does
-- its business work in one transaction keyed on the old dedup table. Its
-- durability therefore rests entirely on the provider's retry policy: an
-- `invoice.paid` that arrives before its `customer.subscription.created` is
-- answered with a 409 so the provider redelivers, and if the provider gives up
-- before the subscription row exists, the invoice is lost with nothing to replay
-- from. That is the same class of silent loss the inbox (026) removed for
-- payments — the payment side keeps the payload and retries from a table it
-- owns; the subscription side merely asks nicely.
--
-- Routing subscription deliveries through the same inbox closes that gap, but the
-- table's integrity CHECK is payment-specific: a processed row must name the
-- payment transaction it credited. A subscription delivery matches a
-- subscription, or nothing at all (a customer.deleted cascading over zero rows is
-- complete work with no single entity to name). So the row needs to say which
-- pipeline owns it, and the CHECK needs to bind only the payment pipeline.

ALTER TABLE paykit.webhook_inbox
  ADD COLUMN IF NOT EXISTS inbox_kind TEXT NOT NULL DEFAULT 'payment'
    CONSTRAINT webhook_inbox_kind_known CHECK (inbox_kind IN ('payment', 'subscription'));

-- The original CHECK guarded against a bug that marks unmatched PAYMENT work as
-- done — a processed payment row naming no transaction is indistinguishable from
-- silent loss. That guarantee stays word-for-word for payment rows. Subscription
-- rows record their matched subscription in matched_transaction_id when there is
-- one, but legitimate no-op events (customer.deleted with no active
-- subscriptions, an invoice event with nothing to key a ledger entry on) finish
-- with nothing to name, so the column stays nullable for them.
ALTER TABLE paykit.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_processed_has_match;
ALTER TABLE paykit.webhook_inbox
  ADD CONSTRAINT webhook_inbox_processed_has_match
    CHECK (
      state <> 'processed'
      OR matched_transaction_id IS NOT NULL
      OR inbox_kind = 'subscription'
    );
