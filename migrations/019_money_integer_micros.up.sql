-- Money columns become integer micros at the type level.
--
-- Every amount_micros / balance column in paykit has always MEANT an integer
-- number of micros (1/1_000_000 of a currency unit), but was declared
-- NUMERIC(20,6). The mismatch made every reader strip a fractional part it did
-- not expect, which truncates money silently if anything ever wrote one.
-- NUMERIC(30,0) makes the storage say what the domain means: the column can no
-- longer HOLD a fraction, so no reader has to decide what to do with one.
--
-- What scale 0 does and does not buy: a fractional INSERT is not rejected, it is
-- rounded half-up at assignment (100.5 stores as 101), and no CHECK can catch it
-- because the constraint only ever sees the already-cast value. Rejecting a
-- fractional amount is therefore the application's job — parseMicros in
-- packages/core/src/money throws rather than truncating, and every write goes
-- out as a bigint that cannot carry a fraction in the first place. What the type
-- change does buy is that the stored value and the domain agree, so the
-- truncate-on-read pattern has nothing left to truncate.
--
-- NUMERIC(30,0) rather than BIGINT: BIGINT tops out near 9.22e18 micros =
-- 9.22e12 currency units, which VND (1 unit = 1_000_000 micros, and ~26k VND
-- to the USD) can plausibly reach on aggregate balances. NUMERIC also keeps the
-- decimal-string round-trip that the driver and every existing reader rely on,
-- so widening the type is not a client-visible change.

-- Step 1 — refuse to migrate data that would lose value.
-- ALTER TYPE to scale 0 ROUNDS silently (Postgres numeric assignment cast), so
-- any pre-existing fractional micro would be altered without a trace. Fail the
-- whole migration instead and report exactly where, so an operator decides.
DO $$
DECLARE
  offenders text := '';
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM paykit.payment_transactions
    WHERE amount_micros <> trunc(amount_micros);
  IF n > 0 THEN
    offenders := offenders || format('payment_transactions.amount_micros: %s row(s); ', n);
  END IF;

  SELECT count(*) INTO n
    FROM paykit.ledger_entries
    WHERE amount_micros <> trunc(amount_micros);
  IF n > 0 THEN
    offenders := offenders || format('ledger_entries.amount_micros: %s row(s); ', n);
  END IF;

  SELECT count(*) INTO n
    FROM paykit.balance_projections
    WHERE current_balance_micros <> trunc(current_balance_micros);
  IF n > 0 THEN
    offenders := offenders
      || format('balance_projections.current_balance_micros: %s row(s); ', n);
  END IF;

  SELECT count(*) INTO n
    FROM paykit.pending_refunds
    WHERE amount_micros <> trunc(amount_micros);
  IF n > 0 THEN
    offenders := offenders || format('pending_refunds.amount_micros: %s row(s); ', n);
  END IF;

  IF offenders <> '' THEN
    RAISE EXCEPTION
      'fractional micros present, refusing to change column type: %', offenders
      USING HINT = 'Reconcile these rows to whole micros first; this migration will not round them.';
  END IF;
END $$;

-- Step 2 — widen and de-scale. No value changes: step 1 proved every value is
-- already whole, and 30 integer digits strictly contains the previous 14.
ALTER TABLE paykit.payment_transactions
  ALTER COLUMN amount_micros TYPE NUMERIC(30,0);

ALTER TABLE paykit.ledger_entries
  ALTER COLUMN amount_micros TYPE NUMERIC(30,0);

ALTER TABLE paykit.balance_projections
  ALTER COLUMN current_balance_micros TYPE NUMERIC(30,0),
  ALTER COLUMN current_balance_micros SET DEFAULT 0;

ALTER TABLE paykit.pending_refunds
  ALTER COLUMN amount_micros TYPE NUMERIC(30,0);
