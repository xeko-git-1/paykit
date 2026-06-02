-- Add a reservation counter so a discount's cap counts COMPLETED payments, not
-- merely created checkout sessions. Checkout reserves (reserved += 1) while
-- reserved + times_redeemed < max_redemptions; the payment webhook commits the
-- reservation (times_redeemed += 1, reserved -= 1) or releases it on
-- failure/expiry (reserved -= 1). reserved bounds in-flight checkouts so the
-- cap cannot be over-granted under concurrency.
ALTER TABLE paykit.discounts
  ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0);
