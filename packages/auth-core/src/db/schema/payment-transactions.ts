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
    // The provider's checkout answer, kept whole so a retry of the same
    // Idempotency-Key can be replayed with the fields a client actually needs
    // (the URLs and the expiry), not just the reference. Its own column rather
    // than metadata_json because other paths rewrite that object wholesale and
    // have no reason to know they must preserve a replay payload.
    checkoutResultJson: jsonb("checkout_result_json"),
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

/**
 * The states a payment can hold.
 *
 * `pending` and `awaiting_payment` mean the same thing — the provider has a
 * checkout and the customer has not paid. Both exist because every historical row
 * uses `pending`, and rewriting them would change the meaning of stored data.
 * New checkouts use the explicit pair (`provider_creating` → `awaiting_payment`);
 * every read path must treat the two as equivalent.
 *
 * `provider_creating` is the one state that is not safe to retry blind: the row
 * exists but the provider may or may not have accepted the checkout, so it needs
 * a reconcile against the provider rather than a second attempt.
 */
export type PaymentStatus =
  | "pending"
  | "provider_creating"
  | "awaiting_payment"
  | "completed"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "expired"
  | "quarantine"
  | "refund_pending_webhook"
  | "screening_pending";

/**
 * The states that mean "the provider has a checkout, the customer has not paid".
 *
 * Derived rather than restated so a new pre-payment state cannot be added without
 * deciding whether it belongs here.
 */
export const AWAITING_PAYMENT_STATUSES: readonly PaymentStatus[] = ["pending", "awaiting_payment"];
