/**
 * Generic webhook router — V1.5.
 *
 * Mounts POST `/{adapterId}` for every adapter in registry. Server-level
 * pipeline:
 *   1. Read raw body
 *   2. adapter.verifyWebhookSignature(rawBody, headers) → 401 if false
 *   3. adapter.parseWebhookPayload(rawBody, headers) → null = silent skip
 *   4. Inside db.transaction:
 *        a. webhook_events INSERT (dedup by (adapterId, event.eventId))
 *        b. SELECT FOR UPDATE on payment_transactions row (red-team CC concurrency)
 *        c. Apply ledger entry + balance projection per event.type
 *        d. Update tx status
 *   5. Emit event via events handler (post-tx commit)
 *
 * Returns 500 on unexpected throw → provider auto-retries (Stripe up to 3 days).
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
} from "@vibecc/paykit";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { applyDelta } from "../../db/repos/balance.repo.js";
import { appendLedgerEntry } from "../../db/repos/ledger.repo.js";
import { updateTransactionStatus } from "../../db/repos/payment.repo.js";
import { tryRecordWebhookEvent } from "../../db/repos/webhook-event.repo.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import type { PaykitEventHandlers } from "../../events/emitter.js";
import { emitEvent } from "../../events/emitter.js";
import { errorJson } from "../shared/response.js";

export interface WebhookRouterDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly events: PaykitEventHandlers;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildWebhookRouter(deps: WebhookRouterDeps): Hono {
  const app = new Hono();

  // Mount one POST handler per registered adapter id.
  for (const adapter of deps.registry.list()) {
    app.post(`/${adapter.id}`, async (c) => handleWebhook(c, adapter, deps));
  }

  return app;
}

async function handleWebhook(
  c: Context,
  adapter: PaymentProviderAdapter,
  deps: WebhookRouterDeps,
): Promise<Response> {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // 1. Signature verify
  if (!adapter.verifyWebhookSignature(rawBody, headers)) {
    return errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature");
  }

  // 2. Parse → NormalizedWebhookEvent | null
  let event: NormalizedWebhookEvent | null;
  try {
    event = adapter.parseWebhookPayload(rawBody, headers);
  } catch (err) {
    deps.logger?.warn(`adapter '${adapter.id}' parseWebhookPayload threw`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson(c, 400, "WEBHOOK_PARSE_ERROR", "Adapter could not parse payload");
  }
  if (!event) {
    return c.json({ received: true, skipped: "adapter_returned_null" });
  }

  let processedTxId: string | null = null;
  let eventTypeProcessed: NormalizedWebhookEvent["type"] | null = null;

  // Capture in local const so TS narrowing works inside the transaction closure.
  const evt: NormalizedWebhookEvent = event;

  await deps.db.transaction(async (tx) => {
    // 3. Dedup by (adapterId, event.eventId)
    const dedup = await tryRecordWebhookEvent(tx, adapter.id, evt.eventId);
    if (!dedup.recorded) return;

    // 4. SELECT FOR UPDATE the payment_transactions row by (provider, provider_ref)
    const [row] = await tx
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, adapter.id),
          eq(paymentTransactions.providerRef, evt.providerRef),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return;

    // 5. Apply state transition per event type
    switch (evt.type) {
      case "payment.completed": {
        if (row.status !== "pending") return;
        if (evt.amountMicros === undefined || evt.currencyCode === undefined) return;
        await appendLedgerEntry(tx, {
          tenantId: row.tenantId,
          ownerId: row.ownerId,
          entryType: "credit",
          amountMicros: evt.amountMicros,
          currencyCode: evt.currencyCode,
          metadataJson: {
            source: "payment",
            provider: adapter.id,
            transactionId: row.transactionId,
            ...evt.metadata,
          },
        });
        await applyDelta(tx, row.tenantId, evt.currencyCode, BigInt(evt.amountMicros));
        const updated = await updateTransactionStatus(tx, row.transactionId, "completed");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.completed";
        }
        break;
      }
      case "payment.refunded": {
        if (evt.refundAmountMicros === undefined || evt.currencyCode === undefined) return;
        const refundMicros = BigInt(evt.refundAmountMicros);
        await appendLedgerEntry(tx, {
          tenantId: row.tenantId,
          ownerId: row.ownerId,
          entryType: "refund",
          amountMicros: (-refundMicros).toString(),
          currencyCode: evt.currencyCode,
          metadataJson: {
            source: "refund",
            provider: adapter.id,
            originalTransactionId: row.transactionId,
            ...evt.metadata,
          },
        });
        await applyDelta(tx, row.tenantId, evt.currencyCode, -refundMicros);
        const updated = await updateTransactionStatus(tx, row.transactionId, "refunded");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.refunded";
        }
        break;
      }
      case "payment.expired": {
        if (row.status !== "pending") return;
        const updated = await updateTransactionStatus(tx, row.transactionId, "expired");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.expired";
        }
        break;
      }
      case "payment.failed": {
        if (row.status !== "pending") return;
        const updated = await updateTransactionStatus(tx, row.transactionId, "failed");
        if (updated !== undefined) {
          processedTxId = updated.transactionId;
          eventTypeProcessed = "payment.failed";
        }
        break;
      }
      default:
        // 'unknown' — already deduped, no DB writes
        break;
    }
  });

  // 6. Emit event AFTER transaction commits (handler errors don't roll back)
  if (processedTxId !== null && eventTypeProcessed !== null) {
    const txId: string = processedTxId;
    const [row] = await deps.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, txId))
      .limit(1);
    if (row !== undefined) {
      const eventLogger = deps.logger ?? { warn: () => {} };
      const t = eventTypeProcessed as NormalizedWebhookEvent["type"];
      if (t === "payment.completed") {
        await emitEvent(deps.events, { type: "payment.completed", transaction: row }, eventLogger);
      } else if (t === "payment.refunded") {
        const refundMicros = event?.refundAmountMicros ?? "0";
        await emitEvent(
          deps.events,
          { type: "payment.refunded", transaction: row, refundAmountMicros: refundMicros },
          eventLogger,
        );
      } else if (t === "payment.expired") {
        await emitEvent(deps.events, { type: "payment.expired", transaction: row }, eventLogger);
      } else if (t === "payment.failed") {
        await emitEvent(deps.events, { type: "payment.failed", transaction: row }, eventLogger);
      }
    }
  }

  return c.json({ received: true });
}
