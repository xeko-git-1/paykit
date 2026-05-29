/**
 * subscription-event.repo — V2. INSERT-only.
 *
 * Append-only enforced at DB layer (RT 15j) via trigger + REVOKE. Repo MUST
 * NOT expose update or delete helpers; the only writer path is `appendEvent`.
 */
import { desc, eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import {
  type NewSubscriptionEvent,
  type SubscriptionEvent,
  subscriptionEvents,
} from "../schema/subscription-events.js";

export interface AppendSubscriptionEventInput {
  readonly subscriptionId: string;
  readonly provider: string;
  readonly eventType: string;
  readonly rawPayload: Record<string, unknown>;
}

export async function appendSubscriptionEvent(
  db: DbOrTx,
  input: AppendSubscriptionEventInput,
): Promise<SubscriptionEvent> {
  const insert: NewSubscriptionEvent = {
    subscriptionId: input.subscriptionId,
    provider: input.provider,
    eventType: input.eventType,
    rawPayloadJson: input.rawPayload,
  };
  const [row] = await db.insert(subscriptionEvents).values(insert).returning();
  if (!row) throw new Error("appendSubscriptionEvent: insert returned no row");
  return row;
}

export async function listEventsForSubscription(
  db: DbOrTx,
  subscriptionId: string,
  limit = 100,
): Promise<SubscriptionEvent[]> {
  return db
    .select()
    .from(subscriptionEvents)
    .where(eq(subscriptionEvents.subscriptionId, subscriptionId))
    .orderBy(desc(subscriptionEvents.createdAt))
    .limit(limit);
}
