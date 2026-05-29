/**
 * V2 — paykit.idempotency_records schema. Tenant-scoped Idempotency-Key replay store.
 *
 * Compound PK (tenant_id, idempotency_key) blocks cross-tenant collisions
 * (RT F6). expires_at default = created_at + 24h matches Stripe's window.
 * request_body_hash detects "same key, different body" → 422.
 */
import { integer, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paykitSchema } from "./payment-transactions.js";

export const idempotencyRecords = paykitSchema.table(
  "idempotency_records",
  {
    tenantId: uuid("tenant_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    provider: text("provider").notNull(),
    routePath: text("route_path").notNull(),
    requestBodyHash: text("request_body_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBodyJson: jsonb("response_body_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.idempotencyKey] }),
  }),
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
