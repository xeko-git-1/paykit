/**
 * V1.5 — pending_refunds table for ZaloPay 2-step refund handling.
 *
 * State machine:
 *   queued    → submitted to provider, awaiting first response
 *   processing → provider returned PROCESSING; reconciler polls every N min
 *   completed  → provider confirmed; ledger entry has been written
 *   failed     → provider rejected; no ledger entry, archived
 *   timed_out  → reconciler exhausted 24h window; admin attention
 *
 * Reconciler picks rows WHERE state IN ('queued','processing') ordered by
 * last_polled_at NULLS FIRST (oldest first). Idempotent via (provider, idempotency_key).
 */
import { integer, jsonb, numeric, pgEnum, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const pendingRefundState = pgEnum("pending_refund_state", [
  "queued",
  "processing",
  "completed",
  "failed",
  "timed_out",
]);

export const pendingRefunds = paykitSchema.table("pending_refunds", {
  pendingId: uuid("pending_id").primaryKey().defaultRandom(),
  transactionId: uuid("transaction_id").notNull(),
  provider: text("provider").notNull(),
  providerRefundId: text("provider_refund_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  amountMicros: numeric("amount_micros", { precision: 20, scale: 6 }).notNull(),
  currencyCode: text("currency_code").notNull(),
  reason: text("reason").notNull(),
  state: text("state").notNull().default("queued"),
  pollAttempts: integer("poll_attempts").notNull().default(0),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PendingRefund = typeof pendingRefunds.$inferSelect;
export type NewPendingRefund = typeof pendingRefunds.$inferInsert;
