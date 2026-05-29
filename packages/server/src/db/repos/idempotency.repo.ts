/**
 * idempotency.repo — V2. Tenant-scoped Idempotency-Key replay store (RT F6).
 *
 * `lookupOrInsert` returns:
 *   - { hit: true,  record }: caller MUST replay record.responseStatus + record.responseBodyJson
 *   - { hit: false, record }: caller proceeds; later fills response via `recordResponse`
 *   - throws IdempotencyBodyMismatchError when same key arrives with different body
 *
 * 24h TTL applied DB-side via DEFAULT NOW() + INTERVAL '24h'. Expired rows
 * are treated as cache miss (caller proceeds; old row overwritten on next
 * `recordResponse` of same key).
 */
import { and, eq, lt } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import {
  type IdempotencyRecord,
  idempotencyRecords,
  type NewIdempotencyRecord,
} from "../schema/idempotency-records.js";

export class IdempotencyBodyMismatchError extends Error {
  constructor(message = "Same Idempotency-Key submitted with different request body") {
    super(message);
    this.name = "IdempotencyBodyMismatchError";
  }
}

export interface LookupInput {
  readonly tenantId: string;
  readonly key: string;
  readonly provider: string;
  readonly routePath: string;
  readonly bodyHash: string;
  readonly now?: Date;
}

export type LookupResult =
  | { readonly hit: true; readonly record: IdempotencyRecord }
  | { readonly hit: false };

export async function lookupIdempotency(db: DbOrTx, input: LookupInput): Promise<LookupResult> {
  const now = input.now ?? new Date();
  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.tenantId, input.tenantId),
        eq(idempotencyRecords.idempotencyKey, input.key),
      ),
    )
    .limit(1);
  if (!existing) return { hit: false };
  if (existing.expiresAt.getTime() <= now.getTime()) return { hit: false };
  if (existing.requestBodyHash !== input.bodyHash) {
    throw new IdempotencyBodyMismatchError();
  }
  return { hit: true, record: existing };
}

export interface RecordResponseInput {
  readonly tenantId: string;
  readonly key: string;
  readonly provider: string;
  readonly routePath: string;
  readonly bodyHash: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
  readonly ttlSeconds?: number;
}

export async function recordIdempotencyResponse(
  db: DbOrTx,
  input: RecordResponseInput,
): Promise<IdempotencyRecord> {
  const ttl = input.ttlSeconds ?? 86_400;
  const insert: NewIdempotencyRecord = {
    tenantId: input.tenantId,
    idempotencyKey: input.key,
    provider: input.provider,
    routePath: input.routePath,
    requestBodyHash: input.bodyHash,
    responseStatus: input.responseStatus,
    responseBodyJson: input.responseBody,
    expiresAt: new Date(Date.now() + ttl * 1000),
  };
  const [row] = await db
    .insert(idempotencyRecords)
    .values(insert)
    .onConflictDoUpdate({
      target: [idempotencyRecords.tenantId, idempotencyRecords.idempotencyKey],
      set: {
        provider: insert.provider,
        routePath: insert.routePath,
        requestBodyHash: insert.requestBodyHash,
        responseStatus: insert.responseStatus,
        responseBodyJson: insert.responseBodyJson,
        expiresAt: insert.expiresAt,
      },
    })
    .returning();
  if (!row) throw new Error("recordIdempotencyResponse: upsert returned no row");
  return row;
}

export async function sweepExpired(db: DbOrTx, before: Date): Promise<number> {
  const deleted = await db
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, before))
    .returning({ key: idempotencyRecords.idempotencyKey });
  return deleted.length;
}
