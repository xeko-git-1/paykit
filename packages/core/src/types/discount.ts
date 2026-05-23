/**
 * Discount hook. Paykit core knows nothing about promo codes — consumer
 * implements `DiscountResolver` and returns either `null` (no discount) or
 * an `AppliedDiscount` with a `consume(tx)` callback.
 *
 * Paykit invokes `consume(tx)` INSIDE the checkout DB transaction. If
 * `consume` returns `false` (race lost), discount is NOT applied and
 * checkout proceeds at full price. If `consume` throws, paykit catches +
 * logs warn and falls back to full price.
 *
 * `DbTransaction` is opaque here (typed in server package as Drizzle's
 * `PgTransaction` handle); core only needs the structural type.
 */

import type { CurrencyCode } from "./money.js";

export type DbTransaction = unknown;

export interface AppliedDiscount {
  readonly percent: number;
  readonly code: string;
  readonly sourceId: string;
  readonly consume: (tx: DbTransaction) => Promise<boolean>;
}

export type DiscountResolver = (
  req: unknown,
  amountMicros: bigint,
  currencyCode: CurrencyCode,
) => Promise<AppliedDiscount | null>;
