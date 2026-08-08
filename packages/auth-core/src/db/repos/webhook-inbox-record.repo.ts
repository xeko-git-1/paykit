/**
 * Recording a webhook delivery — the first of the inbox's two transactions.
 *
 * This write commits on its own, before any business work is attempted. That is
 * the entire reason the inbox exists: the delivery becomes durable independently
 * of whether it can be acted on, so no later decision — an unmatched reference, a
 * thrown handler, a crashed process — can erase the fact that it arrived.
 */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import {
  type NewWebhookInboxRow,
  type WebhookInboxRow,
  webhookInbox,
} from "../schema/webhook-inbox.js";

export interface RecordDeliveryInput {
  readonly provider: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payloadHash: string;
  /** Already redacted by the caller — this repo does not inspect it. */
  readonly rawPayload?: string;
  readonly normalizedPayload?: Record<string, unknown>;
  readonly providerRef?: string;
}

export interface RecordDeliveryResult {
  readonly row: WebhookInboxRow;
  /** False when this delivery was already recorded — a redelivery. */
  readonly created: boolean;
  /**
   * True when an existing row carries a different `payloadHash` for the same
   * event id. The stored payload is never overwritten; the caller logs and
   * meters, because one event id with two bodies is a provider bug or an attack.
   */
  readonly payloadMismatch: boolean;
}

/**
 * Record a delivery, or hand back the row that already holds this event id.
 *
 * Insert-first rather than read-then-insert, so two instances receiving the same
 * redelivery concurrently produce one row instead of a unique-violation 500.
 *
 * `created: false` means "already received", NOT "already handled" — that is the
 * distinction the old dedup table could not express. The caller must read
 * `row.state` to decide what to do.
 */
export async function recordDelivery(
  db: DbOrTx,
  input: RecordDeliveryInput,
): Promise<RecordDeliveryResult> {
  const insert: NewWebhookInboxRow = {
    provider: input.provider,
    eventId: input.eventId,
    eventType: input.eventType,
    payloadHash: input.payloadHash,
    normalizedPayload: input.normalizedPayload ?? {},
  };
  if (input.rawPayload !== undefined) insert.rawPayload = input.rawPayload;
  if (input.providerRef !== undefined) insert.providerRef = input.providerRef;

  const [won] = await db
    .insert(webhookInbox)
    .values(insert)
    .onConflictDoNothing({ target: [webhookInbox.provider, webhookInbox.eventId] })
    .returning();
  if (won !== undefined) return { row: won, created: true, payloadMismatch: false };

  const [existing] = await db
    .select()
    .from(webhookInbox)
    .where(and(eq(webhookInbox.provider, input.provider), eq(webhookInbox.eventId, input.eventId)))
    .limit(1);
  if (existing === undefined) {
    throw new Error("recordDelivery: conflicting inbox row could not be read back");
  }
  return {
    row: existing,
    created: false,
    payloadMismatch: existing.payloadHash !== input.payloadHash,
  };
}
