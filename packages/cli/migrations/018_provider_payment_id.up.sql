-- Add provider_payment_id: the provider-side payment identifier that a refund
-- API needs, when it differs from provider_ref (the checkout/webhook lookup
-- key). NowPayments is the motivating case: provider_ref stores order_id (=
-- transactionId, echoed in every IPN so the webhook router can find the row),
-- but the refund API keys on NowPayments' own numeric payment_id, which only
-- appears in the completion IPN. The webhook router stamps this column on
-- payment.completed so a later refund can supply the correct id. Nullable:
-- most providers refund by provider_ref and never set it.
ALTER TABLE paykit.payment_transactions
  ADD COLUMN provider_payment_id text;
