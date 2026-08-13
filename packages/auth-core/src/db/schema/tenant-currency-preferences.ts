/**
 * Drizzle schema for paykit.tenant_currency_preferences (migration 030).
 *
 * The default currency a tenant's generic checkout requests resolve to when
 * they name an amount but no currency. Keyed by tenant_id TEXT — the ledger's
 * tenant identity — so embedded-mode tenants without a merchants row can hold
 * one. A request default only; wallets stay keyed (tenant_id, currency_code).
 */
import { text, timestamp } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const tenantCurrencyPreferences = paykitSchema.table("tenant_currency_preferences", {
  tenantId: text("tenant_id").primaryKey(),
  currencyCode: text("currency_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TenantCurrencyPreference = typeof tenantCurrencyPreferences.$inferSelect;
export type NewTenantCurrencyPreference = typeof tenantCurrencyPreferences.$inferInsert;
