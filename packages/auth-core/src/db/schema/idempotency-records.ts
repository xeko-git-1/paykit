/**
 * V2 — paykit.idempotency_records schema. Tenant-scoped Idempotency-Key replay store.
 *
 * Compound PK (tenant_id, idempotency_key) blocks cross-tenant collisions
 * (RT F6). expires_at default = created_at + 24h matches Stripe's window.
 * request_body_hash detects "same key, different body" → 422.
 *
 * `state` serializes concurrent requests sharing a key: the first INSERT lands
 * an 'in_flight' row (short TTL); a racing request sees it and is rejected
 * rather than re-running the mutating handler. The winner flips it to 'done'
 * with the response. response_status is null while in_flight.
 *
 * `claim_token` names WHICH request holds the claim, which `state` alone cannot.
 * A handler that outlives the in-flight TTL loses its claim to a reclaiming
 * request, and without a token its finalize still matches on
 * (tenant_id, key, state='in_flight') — writing its response into the new
 * claimant's row. The token is regenerated on every claim and reclaim, so a
 * stale claimant's guard matches nothing.
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
    state: text("state").notNull().default("done"),
    // Ownership of the current claim. Regenerated on claim and on reclaim, so it
    // is the only thing a finalize can safely guard on.
    claimToken: uuid("claim_token").notNull().defaultRandom(),
    // How many times this key has been claimed. Not a guard — kept because it is
    // what answers "was this key reclaimed, and how often?" during an incident.
    claimGeneration: integer("claim_generation").notNull().default(0),
    responseStatus: integer("response_status"),
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
