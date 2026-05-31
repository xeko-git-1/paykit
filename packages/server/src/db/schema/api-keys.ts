/**
 * Drizzle schema for paykit.api_keys — hashed API keys for merchant auth.
 *
 * key_hash stores sha256(plaintext); the plaintext is returned once at creation
 * and never persisted. key_prefix is a short display fragment (e.g. "pk_live_Abc1")
 * for UI identification only — not sufficient for verification.
 *
 * mode (live|test) is a label only in V4.0. Both modes share the same ledger
 * and tenant. Data isolation between live/test is deferred to a future version.
 */
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";
import { merchants } from "./merchants.js";

export const apiKeys = paykitSchema.table("api_keys", {
  keyId: uuid("key_id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.merchantId, { onDelete: "restrict" }),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  mode: text("mode").notNull().default("live"),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
