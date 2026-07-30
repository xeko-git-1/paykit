-- Database-level money invariants.
--
-- Until now nothing stopped a zero or negative charge, a refund reservation for
-- a negative amount, or a currency_code that no adapter and no wallet reader
-- understands. Each of those is a defect that only shows up as missing money:
-- wallets are keyed (tenant_id, currency_code), so a bad currency credits a
-- wallet nobody reads rather than raising anything.
--
-- The service layer checks the same rules first and raises typed errors with the
-- offending values; these constraints are the backstop for any write path that
-- bypasses it (admin SQL, a future repo, a partially updated deployment).
--
-- NOT VALID is deliberately NOT used: the constraints must hold for existing
-- rows too, and a pre-existing violation is something an operator has to see.

-- payment_transactions: a charge is strictly positive. A zero-amount payment is
-- not a payment, and a negative one is a refund wearing the wrong table.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_amount_micros_positive;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_amount_micros_positive
    CHECK (amount_micros > 0);

-- pending_refunds: a refund reservation is strictly positive. The reservation
-- amount is subtracted from refundable headroom, so a negative one would ADD
-- headroom and let the total refunded exceed what was captured.
ALTER TABLE paykit.pending_refunds
  DROP CONSTRAINT IF EXISTS pending_refunds_amount_micros_positive;
ALTER TABLE paykit.pending_refunds
  ADD CONSTRAINT pending_refunds_amount_micros_positive
    CHECK (amount_micros > 0);

-- ledger_entries: any nonzero move. Refunds and debits are stored negative, so
-- this cannot be a > 0 check — but a zero-amount entry is always meaningless and
-- consumes a (provider, source_id, entry_type) slot that a real entry needs.
ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_amount_micros_nonzero;
ALTER TABLE paykit.ledger_entries
  ADD CONSTRAINT ledger_entries_amount_micros_nonzero
    CHECK (amount_micros <> 0);

-- Currency codes: ISO-4217 alpha-3 shape on every table that keys money by
-- currency. The shape check is intentionally broader than the application's
-- allow-list (USD, VND): the allow-list changes with adapter support and lives
-- in code where it can be released, while the shape is a permanent property of
-- the column. A lowercase or 4-letter code is the failure that actually happens
-- (provider payloads echo 'usd'), and it silently forks the wallet key.
ALTER TABLE paykit.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_currency_code_iso4217;
ALTER TABLE paykit.payment_transactions
  ADD CONSTRAINT payment_transactions_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

ALTER TABLE paykit.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_currency_code_iso4217;
ALTER TABLE paykit.ledger_entries
  ADD CONSTRAINT ledger_entries_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

ALTER TABLE paykit.balance_projections
  DROP CONSTRAINT IF EXISTS balance_projections_currency_code_iso4217;
ALTER TABLE paykit.balance_projections
  ADD CONSTRAINT balance_projections_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');

ALTER TABLE paykit.pending_refunds
  DROP CONSTRAINT IF EXISTS pending_refunds_currency_code_iso4217;
ALTER TABLE paykit.pending_refunds
  ADD CONSTRAINT pending_refunds_currency_code_iso4217
    CHECK (currency_code ~ '^[A-Z]{3}$');
