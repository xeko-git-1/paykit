/**
 * Drizzle schema for paykit.balance_projections.
 * PK = (tenant_id, currency_code) — multi-wallet model.
 *
 * Diverges intentionally from VibeCC (single-PK) to fix the
 * multi-currency overwrite bug VibeCC has open as Track B.
 */
import { numeric, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const balanceProjections = paykitSchema.table(
  "balance_projections",
  {
    tenantId: uuid("tenant_id").notNull(),
    currencyCode: text("currency_code").notNull(),
    // Integer micros, signed: a wallet can go negative through an adjustment.
    // Scale 0 matches the column type — a fractional micro has no meaning, and
    // declaring scale 6 here would let Drizzle round-trip a value the database
    // no longer stores.
    currentBalanceMicros: numeric("current_balance_micros", { precision: 30, scale: 0 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.currencyCode] }),
  }),
);

export type BalanceProjection = typeof balanceProjections.$inferSelect;
export type NewBalanceProjection = typeof balanceProjections.$inferInsert;
