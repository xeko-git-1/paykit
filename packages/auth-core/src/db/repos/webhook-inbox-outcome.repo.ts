/**
 * Reporting the outcome of a claimed delivery.
 *
 * Every function here is guarded on `processing`, which is what makes a claim a
 * fence: a worker whose lease expired mid-attempt cannot overwrite the result its
 * replacement already wrote.
 *
 * The ordering rule these enforce is the reason the inbox exists: the caller
 * commits its business transaction FIRST and only then reports here. Nothing in
 * this module may be called from inside the business transaction, because a row
 * marked processed by a transaction that later rolls back is exactly the silent
 * loss the old dedup table produced.
 */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type WebhookInboxRow, webhookInbox } from "../schema/webhook-inbox.js";

/** Guard shared by every outcome: only the holder of the claim may resolve it. */
function ownedClaim(inboxId: string) {
  return and(eq(webhookInbox.inboxId, inboxId), eq(webhookInbox.state, "processing"));
}

/**
 * Mark the delivery done, naming the payment it affected.
 *
 * The transaction id is required rather than optional because a processed row that
 * names nothing is indistinguishable from a bug that marked unmatched work as
 * complete — the database enforces the same rule as a CHECK.
 */
export async function markDeliveryProcessed(
  db: DbOrTx,
  opts: {
    inboxId: string;
    matchedTransactionId: string;
    tenantId: string;
    now?: Date;
  },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "processed",
      matchedTransactionId: opts.matchedTransactionId,
      tenantId: opts.tenantId,
      leaseExpiresAt: null,
      processedAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: now,
    })
    .where(ownedClaim(opts.inboxId))
    .returning();
  return row;
}

/**
 * Park a delivery whose payment cannot be found yet.
 *
 * This is what replaces the silent 200 that used to lose the payment. "No match" is
 * a timing fact, not a verdict: the checkout may still be mid-flight, or its
 * provider reference may not have committed yet. The row stays retryable and an
 * operator can see it.
 */
export async function markDeliveryUnmatched(
  db: DbOrTx,
  opts: { inboxId: string; nextRetryAt: Date; reason?: string; now?: Date },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "unmatched",
      nextRetryAt: opts.nextRetryAt,
      leaseExpiresAt: null,
      lastErrorCode: "NO_MATCHING_TRANSACTION",
      lastErrorMessage: opts.reason ?? "no payment matches this provider reference yet",
      updatedAt: now,
    })
    .where(ownedClaim(opts.inboxId))
    .returning();
  return row;
}

/** Release a delivery for another attempt after processing threw. */
export async function markDeliveryFailed(
  db: DbOrTx,
  opts: {
    inboxId: string;
    nextRetryAt: Date;
    errorCode: string;
    errorMessage: string;
    now?: Date;
  },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "failed",
      nextRetryAt: opts.nextRetryAt,
      leaseExpiresAt: null,
      lastErrorCode: opts.errorCode,
      lastErrorMessage: opts.errorMessage,
      updatedAt: now,
    })
    .where(ownedClaim(opts.inboxId))
    .returning();
  return row;
}

/**
 * Give up on a delivery after its attempts are exhausted.
 *
 * Terminal for workers, deliberately not for humans: the payload is still stored,
 * so an operator can diagnose and requeue. Reaching this state is what should page
 * someone — it means money may have moved at the provider with nothing here to
 * match it against.
 */
export async function markDeliveryDeadLettered(
  db: DbOrTx,
  opts: { inboxId: string; errorCode: string; errorMessage: string; now?: Date },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "dead_letter",
      leaseExpiresAt: null,
      processedAt: now,
      lastErrorCode: opts.errorCode,
      lastErrorMessage: opts.errorMessage,
      updatedAt: now,
    })
    .where(ownedClaim(opts.inboxId))
    .returning();
  return row;
}

/**
 * Put a dead-lettered delivery back in the queue — the operator escape hatch.
 *
 * The reason a delivery died is usually fixable (a payment repaired by hand, a
 * provider reference corrected), and the payload is still here. Attempts reset,
 * because the exhaustion that killed it described a different world. Guarded on
 * `dead_letter` rather than `processing` so this cannot disturb live work.
 */
export async function requeueDeadLetteredDelivery(
  db: DbOrTx,
  opts: { inboxId: string; now?: Date },
): Promise<WebhookInboxRow | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({
      state: "unmatched",
      processingAttempts: 0,
      nextRetryAt: now,
      processedAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(webhookInbox.inboxId, opts.inboxId), eq(webhookInbox.state, "dead_letter")))
    .returning();
  return row;
}
