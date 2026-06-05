/**
 * V2 — paykit.customers schema. Maps (tenant_id, provider) → Stripe customer.
 *
 * PK is compound (tenant_id, provider) so a tenant can later co-locate Polar
 * or other-provider customer rows without schema change. Length CHECK on
 * provider_customer_id bounds Stripe `cus_*` shape (RT 15i).
 */
import { jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const customers = paykitSchema.table(
  "customers",
  {
    tenantId: uuid("tenant_id").notNull(),
    provider: text("provider").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    email: text("email"),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.provider] }),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
