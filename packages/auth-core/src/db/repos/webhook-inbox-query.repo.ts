/**
 * Reading the inbox, and keeping it from growing without bound.
 *
 * These are the operator-facing paths: what is stuck, what happened to a given
 * delivery, and how many rows sit in a state worth alerting on.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type WebhookInboxRow, webhookInbox } from "../schema/webhook-inbox.js";

export async function findDeliveryById(
  db: DbOrTx,
  inboxId: string,
): Promise<WebhookInboxRow | undefined> {
  const [row] = await db
    .select()
    .from(webhookInbox)
    .where(eq(webhookInbox.inboxId, inboxId))
    .limit(1);
  return row;
}

export async function findDeliveryByEvent(
  db: DbOrTx,
  provider: string,
  eventId: string,
): Promise<WebhookInboxRow | undefined> {
  const [row] = await db
    .select()
    .from(webhookInbox)
    .where(and(eq(webhookInbox.provider, provider), eq(webhookInbox.eventId, eventId)))
    .limit(1);
  return row;
}

/** One row of the operator listing — deliberately without the payload columns. */
export interface InboxDeliverySummary {
  readonly inboxId: string;
  readonly provider: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly providerRef: string | null;
  readonly state: string;
  readonly processingAttempts: number;
  readonly nextRetryAt: Date;
  readonly matchedTransactionId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

/**
 * Deliveries in the given states, oldest first.
 *
 * The payload columns are excluded rather than merely unused: a listing endpoint
 * that selected them would turn an operator view into a bulk export of stored
 * bodies, which is the one thing this table must not make easy.
 */
export async function listDeliveriesByState(
  db: DbOrTx,
  states: readonly string[],
  opts: { limit?: number; offset?: number } = {},
): Promise<InboxDeliverySummary[]> {
  return db
    .select({
      inboxId: webhookInbox.inboxId,
      provider: webhookInbox.provider,
      eventId: webhookInbox.eventId,
      eventType: webhookInbox.eventType,
      providerRef: webhookInbox.providerRef,
      state: webhookInbox.state,
      processingAttempts: webhookInbox.processingAttempts,
      nextRetryAt: webhookInbox.nextRetryAt,
      matchedTransactionId: webhookInbox.matchedTransactionId,
      lastErrorCode: webhookInbox.lastErrorCode,
      lastErrorMessage: webhookInbox.lastErrorMessage,
      receivedAt: webhookInbox.receivedAt,
      processedAt: webhookInbox.processedAt,
    })
    .from(webhookInbox)
    .where(inArray(webhookInbox.state, [...states]))
    .orderBy(webhookInbox.receivedAt)
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

/**
 * Drop stored payloads for deliveries settled before `before`, keeping the row.
 *
 * Two reasons, one operation: `raw_payload` is the bulk of the table's size, and it
 * is the part with any chance of holding something sensitive despite redaction. The
 * dedup key and the audit trail are what must last; the body only needs to live
 * long enough to be replayable.
 *
 * Only settled rows are swept. Clearing the payload of a delivery still owed a
 * retry would destroy the ability to perform that retry — the sweep would cause the
 * loss the table prevents.
 */
export async function sweepInboxPayloads(
  db: DbOrTx,
  opts: { before: Date; limit?: number },
): Promise<number> {
  const candidates = sql`(
    SELECT ${webhookInbox.inboxId} FROM ${webhookInbox}
    WHERE ${webhookInbox.state} IN ('processed', 'dead_letter')
      AND ${webhookInbox.processedAt} <= ${opts.before}
      AND ${webhookInbox.rawPayload} IS NOT NULL
    LIMIT ${opts.limit ?? 500}
  )`;
  const swept = await db
    .update(webhookInbox)
    .set({ rawPayload: null, updatedAt: new Date() })
    .where(
      and(
        inArray(webhookInbox.inboxId, candidates),
        // Re-asserted after the sub-select for the same reason every guard here is:
        // the candidate list was computed before these rows were locked.
        inArray(webhookInbox.state, ["processed", "dead_letter"]),
        isNotNull(webhookInbox.rawPayload),
      ),
    )
    .returning({ inboxId: webhookInbox.inboxId });
  return swept.length;
}

/**
 * Count deliveries sitting in the given states, for metrics and health checks.
 *
 * States are always passed explicitly rather than counting the whole table: the
 * retryable and dead-letter sets have partial indexes behind them, an unfiltered
 * count does not.
 */
export async function countDeliveriesByState(
  db: DbOrTx,
  states: readonly string[],
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookInbox)
    .where(inArray(webhookInbox.state, [...states]));
  return row?.count ?? 0;
}
