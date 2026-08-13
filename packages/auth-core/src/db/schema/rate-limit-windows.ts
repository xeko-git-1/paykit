/**
 * Drizzle schema for paykit.rate_limit_windows. Mirrors 029_rate_limit_windows.up.sql.
 *
 * One row per credential, overwritten in place each window — the table never
 * grows and needs no cleanup. See the migration for why fixed-window (the
 * whole consume must be one atomic UPSERT so N instances count exactly).
 */
import { integer, text, timestamp } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const rateLimitWindows = paykitSchema.table("rate_limit_windows", {
  /** api-key id, or the jwt plane's namespaced `jwt:<merchantId>`. */
  bucketKey: text("bucket_key").primaryKey(),
  /** Start of the fixed window `requestCount` belongs to. */
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  /** Requests seen in this window, rejected ones included. */
  requestCount: integer("request_count").notNull().default(0),
});

export type RateLimitWindow = typeof rateLimitWindows.$inferSelect;
export type NewRateLimitWindow = typeof rateLimitWindows.$inferInsert;
