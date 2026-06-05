/**
 * Drizzle schema for paykit.webhook_events.
 * PK = (provider, event_id) — INSERT-first dedup pattern.
 */
import { primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const webhookEvents = paykitSchema.table(
  "webhook_events",
  {
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.eventId] }),
  }),
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
