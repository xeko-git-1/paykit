/**
 * pending-refunds.repo — manages ZaloPay PROCESSING refunds.
 *
 * Reconciler picks rows by `state IN ('queued','processing')` ordered by
 * `last_polled_at NULLS FIRST`. Idempotent insert via `(provider, idempotency_key)`.
 *
 * State transitions are explicit functions; no free-text `state` updates.
 */
import { type SQL, and, asc, eq, lt, or, sql } from "drizzle-orm";
import type { DbClient, DbOrTx } from "../client.js";
import {
  type NewPendingRefund,
  type PendingRefund,
  pendingRefunds,
} from "../schema/pending-refunds.js";

export type PendingRefundState = "queued" | "processing" | "completed" | "failed" | "timed_out";

export interface CreatePendingRefundInput {
  readonly transactionId: string;
  readonly provider: string;
  readonly idempotencyKey: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly reason: string;
  readonly metadataJson?: Record<string, unknown>;
}

/** Insert a queued pending refund; returns existing row on idempotency hit. */
export async function createPendingRefund(
  db: DbOrTx,
  data: CreatePendingRefundInput,
): Promise<PendingRefund> {
  const insert: NewPendingRefund = {
    transactionId: data.transactionId,
    provider: data.provider,
    idempotencyKey: data.idempotencyKey,
    amountMicros: data.amountMicros,
    currencyCode: data.currencyCode,
    reason: data.reason,
    metadataJson: data.metadataJson ?? {},
  };
  const [row] = await db
    .insert(pendingRefunds)
    .values(insert)
    .onConflictDoNothing({ target: [pendingRefunds.provider, pendingRefunds.idempotencyKey] })
    .returning();
  if (row) return row;
  // Idempotent fetch
  const [existing] = await db
    .select()
    .from(pendingRefunds)
    .where(
      and(
        eq(pendingRefunds.provider, data.provider),
        eq(pendingRefunds.idempotencyKey, data.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("createPendingRefund: idempotent fetch returned null");
  return existing;
}

export async function markProcessing(
  db: DbOrTx,
  pendingId: string,
  providerRefundId: string | undefined,
): Promise<PendingRefund | undefined> {
  const update: { state: PendingRefundState; updatedAt: Date; providerRefundId?: string } = {
    state: "processing",
    updatedAt: new Date(),
  };
  if (providerRefundId !== undefined) update.providerRefundId = providerRefundId;
  const [row] = await db
    .update(pendingRefunds)
    .set(update)
    .where(eq(pendingRefunds.pendingId, pendingId))
    .returning();
  return row;
}

export async function markCompleted(
  db: DbOrTx,
  pendingId: string,
): Promise<PendingRefund | undefined> {
  const [row] = await db
    .update(pendingRefunds)
    .set({ state: "completed", updatedAt: new Date() })
    .where(eq(pendingRefunds.pendingId, pendingId))
    .returning();
  return row;
}

export async function markFailed(
  db: DbOrTx,
  pendingId: string,
  reasonMetadata: Record<string, unknown>,
): Promise<PendingRefund | undefined> {
  const [row] = await db
    .update(pendingRefunds)
    .set({ state: "failed", metadataJson: reasonMetadata, updatedAt: new Date() })
    .where(eq(pendingRefunds.pendingId, pendingId))
    .returning();
  return row;
}

export async function markTimedOut(
  db: DbOrTx,
  pendingId: string,
): Promise<PendingRefund | undefined> {
  const [row] = await db
    .update(pendingRefunds)
    .set({ state: "timed_out", updatedAt: new Date() })
    .where(eq(pendingRefunds.pendingId, pendingId))
    .returning();
  return row;
}

export async function recordPollAttempt(db: DbOrTx, pendingId: string): Promise<void> {
  await db
    .update(pendingRefunds)
    .set({
      pollAttempts: sql`${pendingRefunds.pollAttempts} + 1`,
      lastPolledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pendingRefunds.pendingId, pendingId));
}

/**
 * Sum amountMicros of active reservations (queued or processing) for a given transaction.
 * Used inside the FOR UPDATE lock to include reserved-but-not-yet-finalized headroom
 * in the remaining-refundable calculation, preventing PSP/ledger divergence.
 */
export async function sumActiveReservationsByTransaction(
  db: DbOrTx,
  opts: { transactionId: string; currencyCode: string },
): Promise<string> {
  const [row] = await db
    .select({
      totalMicros: sql<string>`COALESCE(SUM(${pendingRefunds.amountMicros}), 0)::text`,
    })
    .from(pendingRefunds)
    .where(
      and(
        eq(pendingRefunds.transactionId, opts.transactionId),
        eq(pendingRefunds.currencyCode, opts.currencyCode),
        or(eq(pendingRefunds.state, "queued"), eq(pendingRefunds.state, "processing")),
      ),
    );
  return row?.totalMicros ?? "0";
}

/**
 * Find an existing pending_refund by (provider, idempotencyKey).
 * Used for dedup-before-gate: if a reservation or completed refund already exists
 * for this key, the retry returns the existing result without re-evaluating remaining.
 */
export async function findByProviderAndKey(
  db: DbOrTx,
  opts: { provider: string; idempotencyKey: string },
): Promise<PendingRefund | undefined> {
  const [row] = await db
    .select()
    .from(pendingRefunds)
    .where(
      and(
        eq(pendingRefunds.provider, opts.provider),
        eq(pendingRefunds.idempotencyKey, opts.idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Find all active (queued/processing) reservations for a given transaction and provider.
 * Used by the webhook handler to release reservations when the committed ledger entry
 * arrives — ensuring remaining is never double-counted (once via committed entry, once
 * via stale reservation).
 */
export async function findActiveByTransaction(
  db: DbOrTx,
  opts: { provider: string; transactionId: string },
): Promise<PendingRefund[]> {
  return db
    .select()
    .from(pendingRefunds)
    .where(
      and(
        eq(pendingRefunds.provider, opts.provider),
        eq(pendingRefunds.transactionId, opts.transactionId),
        or(eq(pendingRefunds.state, "queued"), eq(pendingRefunds.state, "processing")),
      ),
    );
}

/**
 * Reconciler picks: queued/processing rows older than `staleAfter` since last poll.
 * Returns ordered list; reconciler iterates and polls each.
 */
export async function listPollable(
  db: DbClient,
  opts: { limit?: number; staleAfter?: Date } = {},
): Promise<PendingRefund[]> {
  const limit = opts.limit ?? 100;
  const stateCond = or(eq(pendingRefunds.state, "queued"), eq(pendingRefunds.state, "processing"));
  if (stateCond === undefined) {
    throw new Error("listPollable: state condition could not be built");
  }
  const conds: SQL[] = [stateCond];
  if (opts.staleAfter !== undefined) {
    const staleCond = or(
      sql`${pendingRefunds.lastPolledAt} IS NULL`,
      lt(pendingRefunds.lastPolledAt, opts.staleAfter),
    );
    if (staleCond !== undefined) conds.push(staleCond);
  }
  return db
    .select()
    .from(pendingRefunds)
    .where(and(...conds))
    .orderBy(asc(pendingRefunds.lastPolledAt), asc(pendingRefunds.createdAt))
    .limit(limit);
}
