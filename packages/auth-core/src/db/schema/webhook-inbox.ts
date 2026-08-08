/**
 * Drizzle schema for paykit.webhook_inbox — the durable record of a webhook
 * delivery, separate from the record of whether it has been acted on.
 *
 * The table it replaces (`webhook_events`) had one row meaning two things at
 * once: "seen" and "done". The router inserted that row as the first statement
 * of the business transaction, so an early return — no payment matches this
 * provider reference yet — still committed it, answered 200, and made the
 * delivery permanently unrepeatable. A customer's payment could be lost with no
 * log and no replay path.
 *
 * Here receipt and completion are different columns' worth of truth: the UNIQUE
 * (provider, event_id) deduplicates deliveries, and `state` says how far the work
 * got. Losing the dedup conflict means "already received", never "already done".
 *
 * State machine:
 *   received    → accepted and committed; not processed yet
 *   unmatched   → no payment row for this reference yet; retried on a backoff
 *   processing  → claimed by a worker under a lease
 *   processed   → the business transaction committed (terminal)
 *   failed      → processing threw; retried until attempts run out
 *   dead_letter → attempts exhausted; a human decides (terminal)
 */
import { integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const webhookInbox = paykitSchema.table(
  "webhook_inbox",
  {
    inboxId: uuid("inbox_id").primaryKey().defaultRandom(),

    provider: text("provider").notNull(),
    /** The provider's own event id — the dedup key, together with `provider`. */
    eventId: text("event_id").notNull(),

    // Both null until the event matches a payment: an unmatched delivery carries
    // no way to know whose it is, since the provider reference is the only link
    // and that is precisely what has not resolved.
    tenantId: uuid("tenant_id"),
    matchedTransactionId: uuid("matched_transaction_id"),

    eventType: text("event_type").notNull(),
    /** The reference the match is attempted on, kept so a retry need not re-parse. */
    providerRef: text("provider_ref"),

    /**
     * sha256 of the raw body as received. Kept separately from `rawPayload`
     * because that column is redacted before storage and so no longer hashes to
     * the same value — the hash is what still detects two deliveries claiming one
     * event id with different content.
     */
    payloadHash: text("payload_hash").notNull(),

    /**
     * The delivery body, redacted on the way in. Secrets and PII must not become
     * durable merely by passing through a webhook.
     */
    rawPayload: text("raw_payload"),
    /** The parsed event, so a retry does not depend on the adapter parsing identically later. */
    normalizedPayload: jsonb("normalized_payload").notNull().default({}),

    state: text("state").notNull().default("received"),

    processingAttempts: integer("processing_attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
    /** A dead worker's claim expires, so the event is retried instead of stalling. */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),

    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerEventUq: unique("webhook_inbox_provider_event_uq").on(table.provider, table.eventId),
  }),
);

export type WebhookInboxRow = typeof webhookInbox.$inferSelect;
export type NewWebhookInboxRow = typeof webhookInbox.$inferInsert;

/** Every state an inbox row can hold. */
export type WebhookInboxState =
  | "received"
  | "unmatched"
  | "processing"
  | "processed"
  | "failed"
  | "dead_letter";

/**
 * The states a worker may claim from: work that is owed another attempt.
 *
 * Derived from the state list rather than restated, so adding a state forces a
 * decision about whether it is retryable instead of silently defaulting to no.
 */
export const CLAIMABLE_INBOX_STATES: readonly WebhookInboxState[] = [
  "received",
  "unmatched",
  "failed",
];

/**
 * States that mean the delivery is closed and no worker should touch it again.
 * `dead_letter` is terminal for the worker only — an operator can still act.
 */
export const TERMINAL_INBOX_STATES: readonly WebhookInboxState[] = ["processed", "dead_letter"];
