/**
 * idempotency.repo — V2. Tenant-scoped Idempotency-Key replay store (RT F6).
 *
 * Insert-first concurrency model: `claimIdempotency` atomically INSERTs an
 * 'in_flight' row (ON CONFLICT DO NOTHING). The request that wins the insert
 * runs the handler; a concurrent request sharing the same (tenant_id, key)
 * observes the existing row and is told to replay (if done) or back off with
 * 409 (if still in_flight) — it never re-runs the mutating handler. The winner
 * calls `finalizeIdempotency` to record the response, or `releaseIdempotency`
 * if the handler failed so the key can be retried immediately.
 *
 * Race-safety rests on Postgres's atomic INSERT ... ON CONFLICT DO NOTHING:
 * exactly one concurrent INSERT for a given PK returns a row. An in_flight row
 * carries a short TTL so a crashed handler cannot wedge the key permanently.
 */
import { and, eq, lt } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import {
  type IdempotencyRecord,
  type NewIdempotencyRecord,
  idempotencyRecords,
} from "../schema/idempotency-records.js";

export class IdempotencyBodyMismatchError extends Error {
  constructor(message = "Same Idempotency-Key submitted with different request body") {
    super(message);
    this.name = "IdempotencyBodyMismatchError";
  }
}

/** Placeholder lifetime for an in_flight claim; a crashed handler self-heals after this. */
const IN_FLIGHT_TTL_SECONDS = 120;
/** Replay window for a finalized response (matches Stripe's 24h). */
const DONE_TTL_SECONDS = 86_400;

export interface ClaimInput {
  readonly tenantId: string;
  readonly key: string;
  readonly provider: string;
  readonly routePath: string;
  readonly bodyHash: string;
  readonly now?: Date;
}

export type ClaimResult =
  /** We won the claim and inserted an in_flight row — caller runs the handler. */
  | { readonly outcome: "claimed" }
  /** A finalized response already exists — caller replays it. */
  | { readonly outcome: "replay"; readonly record: IdempotencyRecord }
  /** Another request holds an active in_flight claim — caller returns 409. */
  | { readonly outcome: "in_flight" };

/**
 * Atomically claim (tenant_id, key) for processing, or report what already
 * exists. Throws IdempotencyBodyMismatchError when an unexpired row carries a
 * different request body.
 */
export async function claimIdempotency(db: DbOrTx, input: ClaimInput): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  const inFlightExpiry = new Date(now.getTime() + IN_FLIGHT_TTL_SECONDS * 1000);

  const placeholder: NewIdempotencyRecord = {
    tenantId: input.tenantId,
    idempotencyKey: input.key,
    provider: input.provider,
    routePath: input.routePath,
    requestBodyHash: input.bodyHash,
    state: "in_flight",
    responseStatus: null,
    responseBodyJson: {},
    expiresAt: inFlightExpiry,
  };

  // Win-or-nothing insert. A returned row means we own the claim.
  const [won] = await db
    .insert(idempotencyRecords)
    .values(placeholder)
    .onConflictDoNothing()
    .returning();
  if (won) return { outcome: "claimed" };

  // A row already exists. Inspect it.
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
  if (!existing) {
    // Row vanished between the failed insert and this read (concurrent sweep).
    // Treat conservatively as in-flight; the caller retries safely.
    return { outcome: "in_flight" };
  }

  // Expired (done row past its window, or a wedged in_flight placeholder):
  // reclaim it atomically. The expires_at guard ensures only one racer reclaims.
  if (existing.expiresAt.getTime() <= now.getTime()) {
    const [reclaimed] = await db
      .update(idempotencyRecords)
      .set({
        provider: input.provider,
        routePath: input.routePath,
        requestBodyHash: input.bodyHash,
        state: "in_flight",
        responseStatus: null,
        responseBodyJson: {},
        expiresAt: inFlightExpiry,
      })
      .where(
        and(
          eq(idempotencyRecords.tenantId, input.tenantId),
          eq(idempotencyRecords.idempotencyKey, input.key),
          lt(idempotencyRecords.expiresAt, now),
        ),
      )
      .returning();
    return reclaimed ? { outcome: "claimed" } : { outcome: "in_flight" };
  }

  if (existing.requestBodyHash !== input.bodyHash) {
    throw new IdempotencyBodyMismatchError();
  }
  if (existing.state === "done") {
    return { outcome: "replay", record: existing };
  }
  return { outcome: "in_flight" };
}

export interface FinalizeInput {
  readonly tenantId: string;
  readonly key: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
  readonly ttlSeconds?: number;
}

/**
 * Mark our claimed row as done with the handler's response and a 24h replay TTL.
 *
 * Guarded by state='in_flight' so it only finalizes a row we still own: if the
 * handler outran the in_flight TTL and another request reclaimed the key, this
 * matches nothing and returns null rather than overwriting the racer's row with
 * a stale response. The caller treats null as "claim lost" — the mutation
 * already happened, so it must NOT surface that as an error.
 */
export async function finalizeIdempotency(
  db: DbOrTx,
  input: FinalizeInput,
): Promise<IdempotencyRecord | null> {
  const ttl = input.ttlSeconds ?? DONE_TTL_SECONDS;
  const [row] = await db
    .update(idempotencyRecords)
    .set({
      state: "done",
      responseStatus: input.responseStatus,
      responseBodyJson: input.responseBody,
      expiresAt: new Date(Date.now() + ttl * 1000),
    })
    .where(
      and(
        eq(idempotencyRecords.tenantId, input.tenantId),
        eq(idempotencyRecords.idempotencyKey, input.key),
        eq(idempotencyRecords.state, "in_flight"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Drop our in_flight placeholder after a failed handler so the key can be
 * retried immediately. Scoped to state='in_flight' so it never deletes another
 * request's finalized response.
 */
export async function releaseIdempotency(
  db: DbOrTx,
  input: { tenantId: string; key: string },
): Promise<void> {
  await db
    .delete(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.tenantId, input.tenantId),
        eq(idempotencyRecords.idempotencyKey, input.key),
        eq(idempotencyRecords.state, "in_flight"),
      ),
    );
}

export async function sweepExpired(db: DbOrTx, before: Date): Promise<number> {
  const deleted = await db
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, before))
    .returning({ key: idempotencyRecords.idempotencyKey });
  return deleted.length;
}
