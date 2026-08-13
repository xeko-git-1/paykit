/**
 * refund-overdue.repo — surfacing refunds whose confirmation webhook never came.
 *
 * A `pending_webhook` refund (V3.1) moves no money until the provider's webhook
 * lands: the transaction sits in `refund_pending_webhook` and the ledger has
 * nothing. When that webhook never arrives, nothing in the system comes back for
 * the row — the runbook said "manual reconcile after 24h" and relied on a human
 * remembering to look.
 *
 * These functions make the overdue state visible without touching money state.
 * Deciding whether the refund actually happened requires asking the provider,
 * which is the operator's runbook (docs/refund-flows.md), not something a
 * sweeper can guess: flipping the status back would un-reserve an amount the
 * provider may still refund, and writing the debit would move money on no
 * evidence. The marker is a fact ("this went overdue at T"), not a verdict.
 */
import { and, eq, lte, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type PaymentTransaction, paymentTransactions } from "../schema/payment-transactions.js";

/** The metadata key that says "this row was reported overdue at T". */
export const REFUND_WEBHOOK_OVERDUE_KEY = "refund_webhook_overdue_at";

/**
 * Mark refund_pending_webhook rows older than `cutoff` as overdue, once each.
 *
 * A guarded UPDATE with the marker in the WHERE clause, so several instances
 * sweeping concurrently report each row exactly once — the metric this feeds is
 * a counter, and double-marking would double-count. `updated_at` is deliberately
 * NOT bumped: it records when the refund was initiated, and the cutoff
 * comparison depends on it staying that way.
 */
export async function markOverdueRefundWebhooks(
  db: DbOrTx,
  opts: { cutoff: Date; now: Date; limit?: number },
): Promise<PaymentTransaction[]> {
  const limit = opts.limit ?? 50;
  const candidate = sql`(
    SELECT ${paymentTransactions.transactionId} FROM ${paymentTransactions}
    WHERE ${paymentTransactions.status} = 'refund_pending_webhook'
      AND ${paymentTransactions.updatedAt} <= ${opts.cutoff}
      AND ${paymentTransactions.metadataJson} ->> ${REFUND_WEBHOOK_OVERDUE_KEY} IS NULL
    ORDER BY ${paymentTransactions.updatedAt}
    FOR UPDATE SKIP LOCKED
    LIMIT ${limit}
  )`;

  return db
    .update(paymentTransactions)
    .set({
      metadataJson: sql`${paymentTransactions.metadataJson} || jsonb_build_object(${REFUND_WEBHOOK_OVERDUE_KEY}::text, ${opts.now.toISOString()}::text)`,
    })
    .where(
      and(
        sql`${paymentTransactions.transactionId} IN ${candidate}`,
        // Re-assert under the row lock: the sub-select ran before it was taken.
        eq(paymentTransactions.status, "refund_pending_webhook"),
        lte(paymentTransactions.updatedAt, opts.cutoff),
        sql`${paymentTransactions.metadataJson} ->> ${REFUND_WEBHOOK_OVERDUE_KEY} IS NULL`,
      ),
    )
    .returning();
}

export interface OverdueRefundWebhook {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  /** When the refund was initiated (the row entered refund_pending_webhook). */
  readonly pendingSince: Date;
  /** When the sweeper first reported it, or null if only the query sees it yet. */
  readonly overdueAt: string | null;
}

/**
 * Every refund currently waiting on a webhook past the cutoff — the operator's
 * work queue. Computed live rather than from the marker, so a row is listed even
 * if the sweeper has not ticked since it crossed the threshold.
 */
export async function listOverdueRefundWebhooks(
  db: DbOrTx,
  opts: { cutoff: Date; limit?: number; offset?: number },
): Promise<OverdueRefundWebhook[]> {
  const rows = await db
    .select()
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.status, "refund_pending_webhook"),
        lte(paymentTransactions.updatedAt, opts.cutoff),
      ),
    )
    .orderBy(paymentTransactions.updatedAt)
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return rows.map((r) => ({
    transactionId: r.transactionId,
    tenantId: r.tenantId,
    provider: r.provider,
    amountMicros: r.amountMicros,
    currencyCode: r.currencyCode,
    pendingSince: r.updatedAt,
    overdueAt: overdueAtOf(r.metadataJson),
  }));
}

function overdueAtOf(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[REFUND_WEBHOOK_OVERDUE_KEY];
  return typeof value === "string" ? value : null;
}
