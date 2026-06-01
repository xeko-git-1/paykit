/**
 * V4 — paykit.discounts. Tenant-scoped promo codes for the public checkout API.
 *
 * A code is unique within a merchant (tenant_id, code). Redemption is race-safe:
 * the repo's consume() increments times_redeemed only while it is below
 * max_redemptions (NULL = unlimited), so the final redemption cannot be
 * double-spent under concurrent checkouts. percent is stored as NUMERIC and
 * surfaced as a string by the driver — callers parse it to a number.
 */
import { boolean, integer, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const discounts = paykitSchema.table("discounts", {
  discountId: uuid("discount_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  code: text("code").notNull(),
  percent: numeric("percent", { precision: 5, scale: 2 }).notNull(),
  maxRedemptions: integer("max_redemptions"),
  timesRedeemed: integer("times_redeemed").notNull().default(0),
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;
