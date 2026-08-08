/**
 * Claiming a recorded delivery for processing.
 *
 * A claim is an UPDATE ... RETURNING whose precondition lives in the WHERE clause,
 * so it is not a check-then-act: under READ COMMITTED, Postgres re-evaluates the
 * guard against the committed row after taking the row lock, and two workers
 * running the identical statement produce one winner and one no-op.
 *
 * Both claims also reclaim a `processing` row whose lease has expired. Without
 * that, a worker dying mid-attempt would leave the delivery owned by nobody and it
 * would never be retried — the same silent loss the inbox exists to prevent, just
 * one state further along.
 */
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type WebhookInboxRow, webhookInbox } from "../schema/webhook-inbox.js";

/** Retryable states, as SQL-literal text for the sub-select below. */
const CLAIMABLE_SQL = sql`('received', 'unmatched', 'failed')`;
const CLAIMABLE = ["received", "unmatched", "failed"] as const;

/** A lease that has run out is available to whoever asks next. */
function leaseExpired(now: Date) {
  return and(
    eq(webhookInbox.state, "processing"),
    isNotNull(webhookInbox.leaseExpiresAt),
    lte(webhookInbox.leaseExpiresAt, now),
  );
}

/**
 * Take ownership of one due delivery, or return undefined when nothing is due.
 *
 * `leaseMs` must exceed the processing work's own timeout, or a slow-but-healthy
 * attempt has its lease stolen while still running and the work runs twice.
 */
export async function claimNextDelivery(
  db: DbOrTx,
  opts: { leaseMs: number; now?: Date; provider?: string },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();

  const providerFilter =
    opts.provider !== undefined ? sql`AND ${webhookInbox.provider} = ${opts.provider}` : sql``;

  // SKIP LOCKED so concurrent workers do not queue on a row whose guard another
  // worker is about to falsify.
  const candidate = sql`(
    SELECT ${webhookInbox.inboxId} FROM ${webhookInbox}
    WHERE (
      (${webhookInbox.state} IN ${CLAIMABLE_SQL} AND ${webhookInbox.nextRetryAt} <= ${now})
      OR (${webhookInbox.state} = 'processing' AND ${webhookInbox.leaseExpiresAt} <= ${now})
    )
    ${providerFilter}
    ORDER BY ${webhookInbox.nextRetryAt}
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )`;

  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "processing",
      processingAttempts: sql`${webhookInbox.processingAttempts} + 1`,
      leaseExpiresAt: new Date(now.getTime() + opts.leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookInbox.inboxId, candidate),
        // Re-assert claimability: the sub-select ran before the row lock, so a
        // competing worker may have claimed it in between.
        or(
          and(inArray(webhookInbox.state, [...CLAIMABLE]), lte(webhookInbox.nextRetryAt, now)),
          leaseExpired(now),
        ),
      ),
    )
    .returning();
  return row;
}

/**
 * Claim one specific delivery, for inline processing on the request path.
 *
 * The router processes a delivery it just recorded, so it knows the id and must not
 * race a background worker for it. `undefined` means a worker got there first and
 * the caller simply acknowledges — the work is owned elsewhere and will happen.
 *
 * Unlike the queue claim this ignores `nextRetryAt`: the caller is not polling a
 * backoff schedule, it is handling the delivery it is holding right now.
 */
export async function claimDeliveryById(
  db: DbOrTx,
  opts: { inboxId: string; leaseMs: number; now?: Date },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "processing",
      processingAttempts: sql`${webhookInbox.processingAttempts} + 1`,
      leaseExpiresAt: new Date(now.getTime() + opts.leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookInbox.inboxId, opts.inboxId),
        or(inArray(webhookInbox.state, [...CLAIMABLE]), leaseExpired(now)),
      ),
    )
    .returning();
  return row;
}
