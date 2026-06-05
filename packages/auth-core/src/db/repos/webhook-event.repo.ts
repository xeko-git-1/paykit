/**
 * webhook-event.repo — INSERT-first dedup. PK conflict → silent skip.
 *
 * Pattern: webhook handlers wrap their work in `db.transaction(tx => ...)`.
 * Inside, call `tryRecordWebhookEvent(tx, provider, eventId)` FIRST. If
 * `recorded: false`, abandon (this event was already processed).
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { webhookEvents } from "../schema/webhook-events.js";

export interface RecordResult {
  readonly recorded: boolean;
}

export async function tryRecordWebhookEvent(
  db: DbOrTx,
  provider: string,
  eventId: string,
): Promise<RecordResult> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ provider, eventId })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
    .returning();
  return { recorded: inserted.length > 0 };
}

export async function listEvents(
  db: DbOrTx,
  opts: { provider?: string; since?: Date; limit?: number; offset?: number } = {},
) {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const conditions: Array<ReturnType<typeof sql>> = [];
  if (opts.provider !== undefined) {
    conditions.push(sql`${webhookEvents.provider} = ${opts.provider}`);
  }
  if (opts.since !== undefined) {
    conditions.push(sql`${webhookEvents.recordedAt} >= ${opts.since}`);
  }
  const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`true`;
  return db
    .select()
    .from(webhookEvents)
    .where(where)
    .orderBy(sql`${webhookEvents.recordedAt} DESC`)
    .limit(limit)
    .offset(offset);
}
