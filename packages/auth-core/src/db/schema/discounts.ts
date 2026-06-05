/**
 * V4 — paykit.discounts. Tenant-scoped promo codes for the public checkout API.
 *
 * A code is unique within a merchant (tenant_id, code). The cap counts
 * COMPLETED payments: checkout reserves (reserved++) while
 * reserved + times_redeemed < max_redemptions; the payment webhook commits
 * (times_redeemed++, reserved--) or releases on failure (reserved--). reserved
 * bounds in-flight checkouts so the cap can't be over-granted under concurrency
 * (NULL max_redemptions = unlimited). percent is stored as NUMERIC and surfaced
 * as a string by the driver — callers parse it to a number.
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
  reserved: integer("reserved").notNull().default(0),
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;
