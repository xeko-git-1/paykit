/**
 * V2 — paykit.runtime_config schema. Key-value operator toggles with TTL.
 *
 * Val S4 Q3: first user is the canary key `webhook_strict_v2`. Reconciler
 * flips its value on first run after expires_at elapses. Null expires_at
 * means non-expiring.
 */
import { text, timestamp } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const runtimeConfig = paykitSchema.table("runtime_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RuntimeConfig = typeof runtimeConfig.$inferSelect;
export type NewRuntimeConfig = typeof runtimeConfig.$inferInsert;
