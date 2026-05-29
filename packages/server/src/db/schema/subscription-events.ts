/**
 * V2 — paykit.subscription_events schema. Append-only audit log.
 *
 * DB-level enforcement (RT 15j): trigger on UPDATE/DELETE raises + REVOKE on
 * paykit_app role. This schema is INSERT-only via Drizzle — repo MUST NOT
 * expose update/delete helpers.
 */
import { jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const subscriptionEvents = paykitSchema.table("subscription_events", {
  eventId: uuid("event_id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").notNull(),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  rawPayloadJson: jsonb("raw_payload_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;
