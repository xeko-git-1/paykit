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
 *
 * That TTL is why a claim needs an OWNER, not just a state. A handler slower than
 * the TTL loses its claim to a reclaiming request, and both claims look identical
 * to a guard that only checks `state = 'in_flight'` — so the slow handler's
 * finalize lands on the new claimant's row and a caller polling the key reads the
 * wrong request's response. Every claim therefore carries a `claimToken`, and
 * finalize and release both guard on it: a claim that was taken away matches
 * nothing and its owner is told so.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
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
  /**
   * We won the claim — caller runs the handler.
   *
   * `claimToken` must be passed back to `finalizeIdempotency` /
   * `releaseIdempotency`. It is what proves the claim is still ours: without it
   * those calls would match whichever claim currently holds the key, including
   * one belonging to a different request.
   */
  | { readonly outcome: "claimed"; readonly claimToken: string }
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

  // Generated here rather than defaulted by the database so the value is known
  // before the write returns, and so a reclaim below can use the same mechanism.
  const claimToken = randomUUID();

  const placeholder: NewIdempotencyRecord = {
    tenantId: input.tenantId,
    idempotencyKey: input.key,
    provider: input.provider,
    routePath: input.routePath,
    requestBodyHash: input.bodyHash,
    state: "in_flight",
    claimToken,
    claimGeneration: 1,
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
  if (won) return { outcome: "claimed", claimToken: won.claimToken };

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
        // A NEW token. This is what makes the previous claimant's finalize match
        // nothing: it still guards on the token it was given, which no longer
        // names the live claim.
        claimToken,
        claimGeneration: sql`${idempotencyRecords.claimGeneration} + 1`,
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
    return reclaimed
      ? { outcome: "claimed", claimToken: reclaimed.claimToken }
      : { outcome: "in_flight" };
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
  /** The token returned by the claim being finalized. */
  readonly claimToken: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
  readonly ttlSeconds?: number;
}

/**
 * Record the handler's response against the claim that produced it.
 *
 * Guarded on `claim_token`, not on `state = 'in_flight'`. The state alone cannot
 * tell two claimants apart: a handler that outlives the in-flight TTL loses its
 * claim to a reclaiming request, and the reclaimed row is *also* `in_flight`, so
 * a state-only guard matched it and wrote the slow handler's response into the new
 * claimant's row. A caller polling that key then read one request's response as
 * the outcome of another's.
 *
 * Returns null when the claim was lost. That is not an error the caller may
 * surface: its mutation did happen, so a failure response would be a lie. The
 * caller's own response still goes back to its own client.
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
        eq(idempotencyRecords.claimToken, input.claimToken),
        eq(idempotencyRecords.state, "in_flight"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Drop our own in-flight placeholder after a failed handler, so the key can be
 * retried straight away instead of waiting out its TTL.
 *
 * Guarded on `claim_token` for the same reason as the finalize: without it, a slow
 * handler's rollback DELETEd the live claim of whichever request had reclaimed the
 * key, and a third request then re-ran the mutation against a key that looked
 * untouched.
 *
 * Returns whether a row was removed, so a caller that wants to can tell "released
 * my claim" from "my claim was already gone".
 */
export async function releaseIdempotency(
  db: DbOrTx,
  input: { tenantId: string; key: string; claimToken: string },
): Promise<boolean> {
  const deleted = await db
    .delete(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.tenantId, input.tenantId),
        eq(idempotencyRecords.idempotencyKey, input.key),
        eq(idempotencyRecords.claimToken, input.claimToken),
        eq(idempotencyRecords.state, "in_flight"),
      ),
    )
    .returning({ key: idempotencyRecords.idempotencyKey });
  return deleted.length > 0;
}

export async function sweepExpired(db: DbOrTx, before: Date): Promise<number> {
  const deleted = await db
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, before))
    .returning({ key: idempotencyRecords.idempotencyKey });
  return deleted.length;
}
