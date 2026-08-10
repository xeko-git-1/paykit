/**
 * The inbox against a REAL Postgres.
 *
 * Three things here cannot be demonstrated with a mocked client, because the thing
 * under test IS Postgres behaviour:
 *
 *   - `FOR UPDATE SKIP LOCKED` plus a re-asserted guard is what makes two workers
 *     claiming concurrently produce one winner and one no-op. A fake client would
 *     happily hand the same row to both and report success.
 *   - The CHECK constraints are the last line of defence for "a processed row names
 *     the payment it credited". A mock cannot reject anything.
 *   - The generated SQL for the claim sub-select has to actually parse.
 *
 * Gated by PAYKIT_E2E_DATABASE_URL, matching the other pg e2e tests in this repo.
 */
import {
  claimDeliveryById,
  claimNextDelivery,
  countDeliveriesByState,
  listDeliveriesByState,
  markDeliveryDeadLettered,
  markDeliveryFailed,
  markDeliveryProcessed,
  markDeliveryUnmatched,
  recordDelivery,
  requeueDeadLetteredDelivery,
  sweepInboxPayloads,
} from "@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js";
import { webhookInbox } from "@xeko-git-1/paykit-auth-core/db/schema/webhook-inbox.js";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const URL = process.env.PAYKIT_E2E_DATABASE_URL;
const suite = URL ? describe : describe.skip;

let pool: Pool;
let db: ReturnType<typeof drizzle>;

const TX_ID = "a0000000-0000-4000-8000-0000000000f1";
const TENANT_ID = "c0000000-0000-4000-8000-0000000000f2";

function delivery(eventId: string) {
  return {
    provider: "pg-test",
    eventId,
    eventType: "payment.completed",
    payloadHash: `hash-${eventId}`,
    rawPayload: '{"redacted":true}',
    normalizedPayload: { eventId, type: "payment.completed", providerRef: "pr-1" },
    providerRef: "pr-1",
  };
}

suite("webhook inbox against real Postgres", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    db = drizzle(pool);
    // Create only what this file needs, idempotently. Running the migration set
    // here instead would fight the cold-start e2e, which asserts it is the one
    // performing a first migration and fails if the schema already exists — and
    // test file order is not guaranteed. The DDL below mirrors migration 026; the
    // migration's own text and registration are asserted by its shape test.
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS paykit`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS paykit.webhook_inbox (
        inbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        tenant_id UUID,
        matched_transaction_id UUID,
        event_type TEXT NOT NULL,
        provider_ref TEXT,
        payload_hash TEXT NOT NULL,
        raw_payload TEXT,
        normalized_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        state TEXT NOT NULL DEFAULT 'received'
          CHECK (state IN ('received','unmatched','processing','processed','failed','dead_letter')),
        processing_attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_expires_at TIMESTAMPTZ,
        last_error_code TEXT,
        last_error_message TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT webhook_inbox_provider_event_uq UNIQUE (provider, event_id),
        CONSTRAINT webhook_inbox_processed_has_match
          CHECK (state <> 'processed' OR matched_transaction_id IS NOT NULL),
        CONSTRAINT webhook_inbox_processed_at_matches_state
          CHECK ((processed_at IS NOT NULL) = (state IN ('processed','dead_letter')))
      )
    `);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM paykit.webhook_inbox WHERE provider = 'pg-test'`);
  });

  it("records a delivery as received, with no completion timestamp", async () => {
    const r = await recordDelivery(db as never, delivery("e-1"));
    expect(r.created).toBe(true);
    expect(r.row.state).toBe("received");
    expect(r.row.processedAt).toBeNull();
  });

  it("treats a redelivery as already-received, not as already-done", async () => {
    await recordDelivery(db as never, delivery("e-2"));
    const again = await recordDelivery(db as never, delivery("e-2"));

    // The distinction the old dedup table could not express.
    expect(again.created).toBe(false);
    expect(again.row.state).toBe("received");
    expect(again.payloadMismatch).toBe(false);
  });

  it("flags one event id arriving with two different bodies", async () => {
    await recordDelivery(db as never, delivery("e-3"));
    const other = await recordDelivery(db as never, {
      ...delivery("e-3"),
      payloadHash: "a-different-hash",
    });

    expect(other.payloadMismatch).toBe(true);
    // The first payload is never overwritten — it is what the audit trail describes.
    expect(other.row.payloadHash).toBe("hash-e-3");
  });

  it("gives the row to exactly one of two concurrent claims", async () => {
    const r = await recordDelivery(db as never, delivery("e-4"));

    const [a, b] = await Promise.all([
      claimNextDelivery(db as never, { leaseMs: 60_000, provider: "pg-test" }),
      claimNextDelivery(db as never, { leaseMs: 60_000, provider: "pg-test" }),
    ]);

    // One winner, one no-op — the property the guarded UPDATE exists for.
    const winners = [a, b].filter((x) => x !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.inboxId).toBe(r.row.inboxId);
    expect(winners[0]?.state).toBe("processing");
    expect(winners[0]?.processingAttempts).toBe(1);
  });

  it("refuses a second claim on a row already being processed", async () => {
    const r = await recordDelivery(db as never, delivery("e-5"));
    const first = await claimDeliveryById(db as never, {
      inboxId: r.row.inboxId,
      leaseMs: 60_000,
    });
    expect(first).toBeDefined();

    const second = await claimDeliveryById(db as never, {
      inboxId: r.row.inboxId,
      leaseMs: 60_000,
    });
    expect(second).toBeUndefined();
  });

  it("reclaims a row whose worker died and left the lease to expire", async () => {
    const r = await recordDelivery(db as never, delivery("e-6"));
    await claimDeliveryById(db as never, { inboxId: r.row.inboxId, leaseMs: 60_000 });

    // Without reclaiming, a dead worker strands the delivery forever.
    const reclaimed = await claimNextDelivery(db as never, {
      leaseMs: 60_000,
      provider: "pg-test",
      now: new Date(Date.now() + 120_000),
    });
    expect(reclaimed?.inboxId).toBe(r.row.inboxId);
    expect(reclaimed?.processingAttempts).toBe(2);
  });

  it("does not claim a delivery that is not yet due", async () => {
    const r = await recordDelivery(db as never, delivery("e-7"));
    const claimed = await claimDeliveryById(db as never, {
      inboxId: r.row.inboxId,
      leaseMs: 60_000,
    });
    await markDeliveryUnmatched(db as never, {
      inboxId: claimed?.inboxId ?? "",
      nextRetryAt: new Date(Date.now() + 600_000),
    });

    expect(
      await claimNextDelivery(db as never, { leaseMs: 60_000, provider: "pg-test" }),
    ).toBeUndefined();
  });

  it("marks processed with the payment it credited", async () => {
    const r = await recordDelivery(db as never, delivery("e-8"));
    await claimDeliveryById(db as never, { inboxId: r.row.inboxId, leaseMs: 60_000 });

    const done = await markDeliveryProcessed(db as never, {
      inboxId: r.row.inboxId,
      matchedTransactionId: TX_ID,
      tenantId: TENANT_ID,
    });

    expect(done?.state).toBe("processed");
    expect(done?.matchedTransactionId).toBe(TX_ID);
    expect(done?.processedAt).not.toBeNull();
    expect(done?.leaseExpiresAt).toBeNull();
  });

  it("refuses to resolve a delivery the caller does not hold", async () => {
    const r = await recordDelivery(db as never, delivery("e-9"));
    // Never claimed, so state is 'received'.
    const done = await markDeliveryProcessed(db as never, {
      inboxId: r.row.inboxId,
      matchedTransactionId: TX_ID,
      tenantId: TENANT_ID,
    });
    expect(done).toBeUndefined();
  });

  it("walks unmatched → failed → dead_letter → requeue without violating a CHECK", async () => {
    const r = await recordDelivery(db as never, delivery("e-10"));
    const id = r.row.inboxId;

    await claimDeliveryById(db as never, { inboxId: id, leaseMs: 60_000 });
    const unmatched = await markDeliveryUnmatched(db as never, {
      inboxId: id,
      nextRetryAt: new Date(Date.now() - 1000),
    });
    expect(unmatched?.state).toBe("unmatched");
    expect(unmatched?.processedAt).toBeNull();

    await claimDeliveryById(db as never, { inboxId: id, leaseMs: 60_000 });
    const failed = await markDeliveryFailed(db as never, {
      inboxId: id,
      nextRetryAt: new Date(Date.now() - 1000),
      errorCode: "PROCESSING_FAILED",
      errorMessage: "boom",
    });
    expect(failed?.state).toBe("failed");
    expect(failed?.processedAt).toBeNull();

    await claimDeliveryById(db as never, { inboxId: id, leaseMs: 60_000 });
    const dead = await markDeliveryDeadLettered(db as never, {
      inboxId: id,
      errorCode: "NO_MATCHING_TRANSACTION",
      errorMessage: "gave up",
    });
    // dead_letter must carry a timestamp, and needs no matched transaction.
    expect(dead?.state).toBe("dead_letter");
    expect(dead?.processedAt).not.toBeNull();
    expect(dead?.matchedTransactionId).toBeNull();

    const requeued = await requeueDeadLetteredDelivery(db as never, { inboxId: id });
    // The requeue has to clear processed_at, or the CHECK rejects the UPDATE.
    expect(requeued?.state).toBe("unmatched");
    expect(requeued?.processedAt).toBeNull();
    expect(requeued?.processingAttempts).toBe(0);
  });

  it("cannot mark a delivery processed without naming a payment", async () => {
    const r = await recordDelivery(db as never, delivery("e-11"));
    await claimDeliveryById(db as never, { inboxId: r.row.inboxId, leaseMs: 60_000 });

    // The constraint is the backstop for the invariant the processor upholds.
    await expect(
      db.execute(
        sql`UPDATE paykit.webhook_inbox SET state='processed', processed_at=NOW()
            WHERE inbox_id = ${r.row.inboxId}`,
      ),
    ).rejects.toThrow(/webhook_inbox_processed_has_match/);
  });

  it("counts and lists by state without exposing the payload", async () => {
    await recordDelivery(db as never, delivery("e-12"));
    expect(await countDeliveriesByState(db as never, ["received"])).toBeGreaterThanOrEqual(1);

    const rows = await listDeliveriesByState(db as never, ["received"], { limit: 10 });
    const found = rows.find((x) => x.eventId === "e-12");
    expect(found).toBeDefined();
    expect(Object.keys(found ?? {})).not.toContain("rawPayload");
    expect(Object.keys(found ?? {})).not.toContain("normalizedPayload");
  });

  it("sweeps a settled payload and keeps the row", async () => {
    const r = await recordDelivery(db as never, delivery("e-13"));
    await claimDeliveryById(db as never, { inboxId: r.row.inboxId, leaseMs: 60_000 });
    await markDeliveryProcessed(db as never, {
      inboxId: r.row.inboxId,
      matchedTransactionId: TX_ID,
      tenantId: TENANT_ID,
    });

    const swept = await sweepInboxPayloads(db as never, { before: new Date(Date.now() + 1000) });
    expect(swept).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ raw: webhookInbox.rawPayload, state: webhookInbox.state })
      .from(webhookInbox)
      .where(sql`${webhookInbox.inboxId} = ${r.row.inboxId}`);
    expect(row?.raw).toBeNull();
    // The dedup key and the audit trail are what must last.
    expect(row?.state).toBe("processed");
  });

  it("never sweeps a payload still owed a retry", async () => {
    const r = await recordDelivery(db as never, delivery("e-14"));
    await claimDeliveryById(db as never, { inboxId: r.row.inboxId, leaseMs: 60_000 });
    await markDeliveryUnmatched(db as never, {
      inboxId: r.row.inboxId,
      nextRetryAt: new Date(Date.now() - 1000),
    });

    await sweepInboxPayloads(db as never, { before: new Date(Date.now() + 86_400_000) });

    const [row] = await db
      .select({ raw: webhookInbox.rawPayload })
      .from(webhookInbox)
      .where(sql`${webhookInbox.inboxId} = ${r.row.inboxId}`);
    // Clearing this would destroy the ability to perform the retry it is owed.
    expect(row?.raw).not.toBeNull();
  });
});
