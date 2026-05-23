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
