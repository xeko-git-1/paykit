/**
 * Drizzle schema for paykit.ledger_entries. Append-only.
 * `entry_type` constrained at SQL layer (CHECK constraint in 001_init.up.sql).
 */
import { jsonb, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const ledgerEntries = paykitSchema.table("ledger_entries", {
  entryId: uuid("entry_id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  ownerId: uuid("owner_id").notNull(),
  entryType: text("entry_type").notNull(),
  amountMicros: numeric("amount_micros", { precision: 20, scale: 6 }).notNull(),
  currencyCode: text("currency_code").notNull(),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
