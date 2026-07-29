/**
 * Drizzle schema for paykit.payment_transactions. Mirrors 001_init.up.sql.
 * V1.5: extended with `internal_id` UUID for cross-provider ID mapping
 * (ZaloPay app_trans_id format `YYMMDD_<id>` ≠ paykit UUID).
 */
import { jsonb, numeric, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const paykitSchema = pgSchema("paykit");

export const paymentTransactions = paykitSchema.table(
  "payment_transactions",
  {
    transactionId: uuid("transaction_id").primaryKey().defaultRandom(),
    internalId: uuid("internal_id").notNull().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    provider: text("provider").notNull(),
    // Integer micros. Scale 0 because a fractional micro has no meaning here;
    // see the money helpers in core for the parse/format contract.
    amountMicros: numeric("amount_micros", { precision: 30, scale: 0 }).notNull(),
    currencyCode: text("currency_code").notNull().default("USD"),
    status: text("status").notNull().default("pending"),
    providerRef: text("provider_ref"),
    // Provider-side payment id for refunds when it differs from provider_ref.
    // NowPayments: provider_ref = order_id (webhook lookup key), but the refund
    // API keys on NowPayments' numeric payment_id, which only arrives in the
    // completion IPN. Stamped on payment.completed; null for providers that
    // refund by provider_ref.
    providerPaymentId: text("provider_payment_id"),
    idempotencyKey: text("idempotency_key"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotency keys are only unique within a single tenant — prevents one
    // tenant from reading another's transaction via key replay.
    tenantIdemKey: unique().on(table.tenantId, table.idempotencyKey),
  }),
);

export type PaymentTransaction = typeof paymentTransactions.$inferSelect;
export type NewPaymentTransaction = typeof paymentTransactions.$inferInsert;
