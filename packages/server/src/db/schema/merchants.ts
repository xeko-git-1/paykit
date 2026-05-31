/**
 * Drizzle schema for paykit.merchants — root tenant entity for V4 service.
 *
 * Each merchant owns API keys and maps 1:1 to tenantId/ownerId in the existing
 * ledger and payment context. Sub-merchant / marketplace hierarchy is deferred
 * to a future migration when the need arises.
 */
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const merchants = paykitSchema.table("merchants", {
  merchantId: uuid("merchant_id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
