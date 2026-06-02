-- Drop the reservation counter. Any in-flight reservations are abandoned (the
-- cap reverts to counting times_redeemed only). Safe: reserved carries no
-- durable financial record, only transient in-flight checkout state.
ALTER TABLE paykit.discounts
  DROP COLUMN IF EXISTS reserved;
