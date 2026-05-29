-- V3 (Phase 03) — extend payment_transactions.status enum with 'refund_pending_webhook'.
--
-- Required by V3 NowPayments adapter (and BitPay in Phase 02) when an admin
-- refund call returns 4xx/5xx but the provider may still complete the refund
-- asynchronously via webhook (Validation Session 2 D8).
--
-- Server writes status='refund_pending_webhook' instead of 'failed'; admin UI
-- surfaces "Refund processing — awaiting confirmation". When the webhook
-- arrives ≤24h later, ledger writes via appendLedgerEntryIdempotent UNIQUE
-- (Phase 0a) and status flips to 'refunded'.
--
-- 24h timeout → manual reconcile via /admin/billing/ledger/adjust for V3 GA;
-- auto-flip-to-refund_failed deferred V3.1.

ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_status_check;

ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_status_check
    CHECK (status IN (
      'pending',
      'completed',
      'failed',
      'refunded',
      'expired',
      'quarantine',
      'refund_pending_webhook'
    ));
