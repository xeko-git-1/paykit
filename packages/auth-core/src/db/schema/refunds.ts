/**
 * Drizzle schema for paykit.refunds — a refund's own identity and lifecycle.
 *
 * Before this table a refund existed only as a negative `ledger_entries` row, and
 * "how much has been refunded" was a SUM over those rows matched by
 * `metadata_json->>'originalTransactionId'`. Two defects follow from that and
 * neither is fixable while the ledger is the only record:
 *
 *   - The ledger is unique on (provider, source_id, entry_type). With the payment
 *     reference as `source_id`, a SECOND partial refund of one payment collides
 *     with the first, the insert reports "already present", and the balance delta
 *     is skipped — the money never leaves the wallet while the caller sees
 *     success. A refund needs its own id to key the ledger on.
 *   - With no per-refund amount there is nothing to compare a refunded total
 *     against, so any refund at all moves the payment to `refunded`.
 *
 * The ledger stays what it is: the wallet's event log. A row here is the refund;
 * the ledger row is the accounting effect of that refund reaching `succeeded`.
 *
 * State machine:
 *   requested       → accepted locally, not yet sent to the provider
 *   submitted       → provider call made, outcome not yet known
 *   pending_webhook → provider accepted, confirmation arrives asynchronously
 *   succeeded       → money moved; `ledgerEntryId` is set, and only then
 *   failed          → provider rejected or the reconciler gave up; no money moved
 *   rejected        → refused locally before any provider call (exceeds
 *                     remaining, not refundable, currency mismatch)
 *
 * `succeeded` and a present `ledgerEntryId` are equivalent — enforced by a CHECK
 * in the migration, because the derived refunded total sums `succeeded` rows and
 * would otherwise be able to count money that never moved.
 */
import { jsonb, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const refunds = paykitSchema.table(
  "refunds",
  {
    refundId: uuid("refund_id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    provider: text("provider").notNull(),
    // The provider's own id for this refund. This is what a refund webhook
    // carries, so it is how an inbound event finds its row. Null between
    // requesting a refund and the provider accepting it, and on refunds
    // backfilled from history that never recorded one.
    providerRefundId: text("provider_refund_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    // Strictly positive. Direction lives on the ledger entry (negative), not
    // here; a zero or negative refund amount is a defect.
    amountMicros: numeric("amount_micros", { precision: 30, scale: 0 }).notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").notNull().default("requested"),
    // Why the refund was requested.
    reason: text("reason").notNull().default(""),
    // Why it did not succeed — kept apart from `reason` because a provider
    // rejection and a local refusal are different events, diagnosed differently.
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    // The ledger row this refund produced. Set exactly when status is
    // 'succeeded'.
    ledgerEntryId: uuid("ledger_entry_id"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
  },
  (table) => ({
    // Retrying a refund request with the same caller key must not produce a
    // second refund.
    providerIdempotencyUq: unique().on(table.provider, table.idempotencyKey),
  }),
);

export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;

/** States a refund can hold. */
export type RefundStatus =
  | "requested"
  | "submitted"
  | "pending_webhook"
  | "succeeded"
  | "failed"
  | "rejected";

/**
 * The statuses that mean "this refund will not move money". Derived rather than
 * restated so adding a status forces a decision about whether it frees the
 * headroom it had claimed, instead of silently defaulting to "still in flight".
 */
export type RefundTerminalFailure = Extract<RefundStatus, "failed" | "rejected">;
