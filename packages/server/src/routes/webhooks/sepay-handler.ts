/**
 * POST /webhooks/sepay — process incoming bank transfer webhook.
 *
 * Lock order (verbatim from VibeCC, port to paykit):
 *   webhook_events INSERT → payment_transactions FOR UPDATE → ledger → balance → status
 *
 * Tenancy: NOT from TenantResolver. Read from the locked payment_transactions row.
 *
 * Underpayment guard: payload.transferAmount must be ≥ expected VND on the row.
 */
import { AmountMismatchError, microsStringToBigInt } from "@vibecc/paykit";
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
import type { SePayClient, SePayWebhookPayload } from "../../providers/sepay/client.js";
import { errorJson } from "../shared/response.js";

export interface SepayWebhookDeps {
  readonly db: DbClient;
  readonly sepayClient: SePayClient;
  readonly events: PaykitEventHandlers;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildSepayWebhookRoute(deps: SepayWebhookDeps): Hono {
  const app = new Hono();
  const { db, sepayClient, events, logger } = deps;

  app.post("/sepay", async (c) => handleSepay(c, db, sepayClient, events, logger));

  return app;
}

async function handleSepay(
  c: Context,
  db: DbClient,
  sepayClient: SePayClient,
  events: PaykitEventHandlers,
  logger?: SepayWebhookDeps["logger"],
): Promise<Response> {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-sepay-signature") ?? "";
  if (!sepayClient.verifyWebhookSignature(rawBody, signature)) {
    return errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid SePay signature");
  }

  let payload: SePayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SePayWebhookPayload;
  } catch {
    return errorJson(c, 400, "VALIDATION_ERROR", "Malformed JSON payload");
  }

  // Outgoing transfers are not credits — no-op without polluting webhook_events.
  if (payload.transferType !== "in") {
    return c.json({ received: true });
  }

  const orderId = sepayClient.extractOrderId(payload.content ?? payload.description);
  if (!orderId) {
    return c.json({ received: true });
  }

  let completedTx: { transactionId: string } | null = null;
  let amountMismatchInfo: { transactionId: string; reason: string } | null = null;

  try {
    await db.transaction(async (tx) => {
      // 1. Dedup by PK (provider, event_id). Skip if already processed.
      const dedup = await tryRecordWebhookEvent(tx, "sepay", `sepay:${payload.id}`);
      if (!dedup.recorded) return;

      // 2. Lock the pending payment_transactions row by (provider, provider_ref).
      const [t] = await tx
        .select()
        .from(paymentTransactions)
        .where(
          and(
            eq(paymentTransactions.provider, "sepay"),
            eq(paymentTransactions.providerRef, orderId),
          ),
        )
        .for("update")
        .limit(1);
      if (!t || t.status !== "pending") return;

      // 3. Underpayment guard. amount_micros stored VND-native (× 1_000_000).
      const expectedVnd = Number(microsStringToBigInt(t.amountMicros) / 1_000_000n);
      if (payload.transferAmount < expectedVnd) {
        throw new AmountMismatchError(
          `SePay transferAmount=${payload.transferAmount} VND < expected=${expectedVnd} VND for tx ${t.transactionId}`,
        );
      }

      // 4. Append ledger credit + apply balance delta.
      await appendLedgerEntry(tx, {
        tenantId: t.tenantId,
        ownerId: t.ownerId,
        entryType: "credit",
        amountMicros: t.amountMicros,
        currencyCode: t.currencyCode,
        metadataJson: {
          source: "payment",
          provider: "sepay",
          transactionId: t.transactionId,
          sepayEventId: payload.id,
          referenceCode: payload.referenceCode,
        },
      });
      await applyDelta(tx, t.tenantId, t.currencyCode, microsStringToBigInt(t.amountMicros));

      // 5. Status update — last write so a downstream throw still rolls everything back.
      const updated = await updateTransactionStatus(tx, t.transactionId, "completed");
      if (updated !== undefined) {
        completedTx = { transactionId: updated.transactionId };
      }
    });
  } catch (err) {
    if (err instanceof AmountMismatchError) {
      amountMismatchInfo = {
        transactionId: orderId,
        reason: err.message,
      };
    } else {
      throw err;
    }
  }

  // Emit AFTER transaction commits — handler errors must not affect ledger.
  if (completedTx !== null) {
    const completedId: string = (completedTx as { transactionId: string }).transactionId;
    const [row] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, completedId))
      .limit(1);
    if (row) {
      const eventLogger = logger ?? { warn: () => {} };
      await emitEvent(events, { type: "payment.completed", transaction: row }, eventLogger);
    }
  }

  if (amountMismatchInfo) {
    return c.json({
      received: true,
      blocked: "amount_mismatch",
      message: amountMismatchInfo.reason,
    });
  }
  return c.json({ received: true });
}
