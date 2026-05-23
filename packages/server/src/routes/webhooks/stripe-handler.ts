/**
 * POST /webhooks/stripe — handles 3 Stripe event types in V1:
 *
 *   - checkout.session.completed → ledger credit + balance increase
 *   - charge.refunded            → ledger debit (entry_type='refund') + balance reduce
 *   - checkout.session.expired   → mark pending tx as expired (no ledger write)
 *
 * Lock order:  webhook_events INSERT → payment_transactions FOR UPDATE → ledger → balance → status
 *
 * Currency assert (USD only) BEFORE the transaction so non-USD short-circuits
 * without orphaning a pending row.
 */
import {
  UnsupportedCurrencyError,
  WebhookSignatureError,
  microsStringToBigInt,
  stripeUsdAmountToMicros,
} from "@vibecc/paykit";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type Stripe from "stripe";
import type { DbClient } from "../../db/client.js";
import { applyDelta } from "../../db/repos/balance.repo.js";
import { appendLedgerEntry } from "../../db/repos/ledger.repo.js";
import { updateTransactionStatus } from "../../db/repos/payment.repo.js";
import { tryRecordWebhookEvent } from "../../db/repos/webhook-event.repo.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import type { PaykitEventHandlers } from "../../events/emitter.js";
import { emitEvent } from "../../events/emitter.js";
import type { StripeClient } from "../../providers/stripe/client.js";
import { errorJson } from "../shared/response.js";

export interface StripeWebhookDeps {
  readonly db: DbClient;
  readonly stripeClient: StripeClient;
  readonly events: PaykitEventHandlers;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildStripeWebhookRoute(deps: StripeWebhookDeps): Hono {
  const app = new Hono();
  app.post("/stripe", async (c) => handleStripe(c, deps));
  return app;
}

async function handleStripe(c: Context, deps: StripeWebhookDeps): Promise<Response> {
  const { db, stripeClient, events, logger } = deps;
  const rawBody = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = stripeClient.constructWebhookEvent(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return errorJson(c, 401, err.code, err.message);
    }
    return errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid Stripe signature");
  }

  if (event.type === "checkout.session.completed") {
    return handleCheckoutCompleted(c, event, db, events, logger);
  }
  if (event.type === "charge.refunded") {
    return handleChargeRefunded(c, event, db, events, logger);
  }
  if (event.type === "checkout.session.expired") {
    return handleCheckoutExpired(c, event, db, events, logger);
  }

  // Other event types acknowledged but ignored.
  return c.json({ received: true, ignored: event.type });
}

async function handleCheckoutCompleted(
  c: Context,
  event: Stripe.Event,
  db: DbClient,
  events: PaykitEventHandlers,
  logger: StripeWebhookDeps["logger"],
): Promise<Response> {
  const session = event.data.object as Stripe.Checkout.Session;
  const tenantId = session.metadata?.tenantId;
  const ownerId = session.metadata?.ownerId;
  if (!tenantId || !ownerId) return c.json({ received: true, skipped: "no-tenant-metadata" });

  // Currency assert BEFORE transaction.
  let amountMicrosBig: bigint;
  try {
    amountMicrosBig = stripeUsdAmountToMicros(session.amount_total ?? 0, session.currency ?? "usd");
  } catch (err) {
    if (err instanceof UnsupportedCurrencyError) {
      return errorJson(c, 400, err.code, err.message);
    }
    throw err;
  }
  const amountMicros = amountMicrosBig.toString();

  let completedTxId: string | null = null;

  await db.transaction(async (tx) => {
    const dedup = await tryRecordWebhookEvent(tx, "stripe", event.id);
    if (!dedup.recorded) return;

    const [t] = await tx
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, "stripe"),
          eq(paymentTransactions.providerRef, session.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!t || t.status !== "pending") return;

    await appendLedgerEntry(tx, {
      tenantId,
      ownerId,
      entryType: "credit",
      amountMicros,
      currencyCode: "USD",
      metadataJson: {
        source: "payment",
        provider: "stripe",
        sessionId: session.id,
        transactionId: t.transactionId,
        stripeEventId: event.id,
      },
    });
    await applyDelta(tx, tenantId, "USD", amountMicrosBig);
    const updated = await updateTransactionStatus(tx, t.transactionId, "completed");
    completedTxId = updated?.transactionId ?? null;
  });

  if (completedTxId) {
    const [row] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, completedTxId))
      .limit(1);
    if (row) {
      await emitEvent(events, { type: "payment.completed", transaction: row }, logger);
    }
  }
  return c.json({ received: true });
}

async function handleChargeRefunded(
  c: Context,
  event: Stripe.Event,
  db: DbClient,
  events: PaykitEventHandlers,
  logger: StripeWebhookDeps["logger"],
): Promise<Response> {
  const charge = event.data.object as Stripe.Charge;
  const refundedTotal = charge.amount_refunded;
  const currency = charge.currency ?? "usd";

  let refundMicrosBig: bigint;
  try {
    refundMicrosBig = stripeUsdAmountToMicros(refundedTotal, currency);
  } catch (err) {
    if (err instanceof UnsupportedCurrencyError) {
      return errorJson(c, 400, err.code, err.message);
    }
    throw err;
  }

  // Locate the original payment_transactions row via Charge → PaymentIntent → CheckoutSession.
  // Stripe Charge has `payment_intent`. Apps store provider_ref = session.id.
  // We search by metadata hop: the Charge's payment_intent is in checkout session.payment_intent.
  // For V1 we try exact-match by `payment_intent` if checkout session id is in metadata.
  const checkoutSessionId =
    typeof charge.metadata?.checkoutSessionId === "string"
      ? charge.metadata.checkoutSessionId
      : null;

  const eventDedupKey = `refund:${event.id}`;
  let refundedTxId: string | null = null;

  await db.transaction(async (tx) => {
    const dedup = await tryRecordWebhookEvent(tx, "stripe", eventDedupKey);
    if (!dedup.recorded) return;

    let row: typeof paymentTransactions.$inferSelect | undefined;
    if (checkoutSessionId !== null) {
      const [r] = await tx
        .select()
        .from(paymentTransactions)
        .where(
          and(
            eq(paymentTransactions.provider, "stripe"),
            eq(paymentTransactions.providerRef, checkoutSessionId),
          ),
        )
        .for("update")
        .limit(1);
      row = r;
    }
    if (!row) return; // V1: cannot link refund without metadata hint; reconciler picks up.

    await appendLedgerEntry(tx, {
      tenantId: row.tenantId,
      ownerId: row.ownerId,
      entryType: "refund",
      amountMicros: (-refundMicrosBig).toString(),
      currencyCode: "USD",
      metadataJson: {
        source: "refund",
        provider: "stripe",
        chargeId: charge.id,
        refundId: charge.refunds?.data?.[0]?.id ?? null,
        originalTransactionId: row.transactionId,
        stripeEventId: event.id,
      },
    });
    await applyDelta(tx, row.tenantId, "USD", -refundMicrosBig);
    await updateTransactionStatus(tx, row.transactionId, "refunded");
    refundedTxId = row.transactionId;
  });

  if (refundedTxId) {
    const [row] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, refundedTxId))
      .limit(1);
    if (row) {
      await emitEvent(
        events,
        {
          type: "payment.refunded",
          transaction: row,
          refundAmountMicros: refundMicrosBig.toString(),
        },
        logger,
      );
    }
  }
  return c.json({ received: true });
}

async function handleCheckoutExpired(
  c: Context,
  event: Stripe.Event,
  db: DbClient,
  events: PaykitEventHandlers,
  logger: StripeWebhookDeps["logger"],
): Promise<Response> {
  const session = event.data.object as Stripe.Checkout.Session;
  let expiredTxId: string | null = null;

  await db.transaction(async (tx) => {
    const dedup = await tryRecordWebhookEvent(tx, "stripe", `expired:${event.id}`);
    if (!dedup.recorded) return;

    const [t] = await tx
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, "stripe"),
          eq(paymentTransactions.providerRef, session.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!t || t.status !== "pending") return;

    const updated = await updateTransactionStatus(tx, t.transactionId, "expired");
    expiredTxId = updated?.transactionId ?? null;
  });

  if (expiredTxId) {
    const [row] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, expiredTxId))
      .limit(1);
    if (row) {
      await emitEvent(events, { type: "payment.expired", transaction: row }, logger);
    }
  }
  return c.json({ received: true });
}
