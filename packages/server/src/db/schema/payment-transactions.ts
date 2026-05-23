/**
 * Drizzle schema for paykit.payment_transactions. Mirrors 001_init.up.sql.
 * V1.5: extended with `internal_id` UUID for cross-provider ID mapping
 * (ZaloPay app_trans_id format `YYMMDD_<id>` ≠ paykit UUID).
 */
import { jsonb, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const paykitSchema = pgSchema("paykit");

export const paymentTransactions = paykitSchema.table("payment_transactions", {
  transactionId: uuid("transaction_id").primaryKey().defaultRandom(),
  internalId: uuid("internal_id").notNull().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  ownerId: uuid("owner_id").notNull(),
  provider: text("provider").notNull(),
  amountMicros: numeric("amount_micros", { precision: 20, scale: 6 }).notNull(),
  currencyCode: text("currency_code").notNull().default("USD"),
  status: text("status").notNull().default("pending"),
  providerRef: text("provider_ref"),
  idempotencyKey: text("idempotency_key").unique(),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PaymentTransaction = typeof paymentTransactions.$inferSelect;
export type NewPaymentTransaction = typeof paymentTransactions.$inferInsert;
