/**
 * V2 — paykit.subscriptions schema. Local cache of Stripe subscription state.
 *
 * status TEXT (RT F3) — adapter mapper validates app-side; future Stripe
 * statuses don't crash inserts. UNIQUE (provider, provider_subscription_id)
 * is the conflict target for `INSERT ... ON CONFLICT` upserts. last_event_created
 * (RT F9) feeds the last-write-wins UPSERT predicate.
 */
import { boolean, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const subscriptions = paykitSchema.table(
  "subscriptions",
  {
    subscriptionId: uuid("subscription_id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    provider: text("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    customerId: text("customer_id").notNull(),
    priceId: text("price_id").notNull(),
    status: text("status").notNull(),
    currencyCode: text("currency_code").notNull().default("USD"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    latestInvoiceId: text("latest_invoice_id"),
    lastEventCreated: timestamp("last_event_created", { withTimezone: true }).notNull(),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerSubUq: unique().on(table.provider, table.providerSubscriptionId),
  }),
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
