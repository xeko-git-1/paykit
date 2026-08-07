/**
 * refund.repo — the refund's own lifecycle, independent of the ledger.
 *
 * A refund used to exist only as a negative `ledger_entries` row, which left two
 * things unrepresentable: a refund that has been requested but not yet paid out,
 * and two partial refunds of the same payment. The second one is the money bug —
 * the ledger's uniqueness is (provider, source_id, entry_type), so two refunds
 * keyed on the same payment reference collapse into one row and the second
 * balance delta is silently skipped.
 *
 * So the refund gets an identity here, and the ledger row keyed on that identity
 * becomes the accounting effect of a refund reaching `succeeded`. The refunded
 * total is derived (`sumSucceededByTransaction`) rather than stored, so it cannot
 * drift from the rows it summarises.
 *
 * Status transitions are explicit functions, and each one is a guarded UPDATE:
 * the guard is what makes a redelivered provider webhook a no-op instead of a
 * second payout. No free-text status writes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type NewRefund, type Refund, type RefundStatus, refunds } from "../schema/refunds.js";

/** Statuses from which a refund may still reach `succeeded`. */
const OPEN_STATUSES: readonly RefundStatus[] = ["requested", "submitted", "pending_webhook"];

export interface CreateRefundInput {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly idempotencyKey: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly reason?: string;
  readonly providerRefundId?: string;
  readonly metadataJson?: Record<string, unknown>;
}

/**
 * Record a refund request.
 *
 * `(provider, idempotency_key)` is unique, so a retried request returns the
 * existing row rather than creating a second refund. The caller distinguishes the
 * two cases through `created`: a retry must not re-run the provider call.
 */
export async function createRefund(
  db: DbOrTx,
  data: CreateRefundInput,
): Promise<{ readonly row: Refund; readonly created: boolean }> {
  const insert: NewRefund = {
    transactionId: data.transactionId,
    tenantId: data.tenantId,
    ownerId: data.ownerId,
    provider: data.provider,
    idempotencyKey: data.idempotencyKey,
    amountMicros: data.amountMicros,
    currencyCode: data.currencyCode,
    reason: data.reason ?? "",
    metadataJson: data.metadataJson ?? {},
    ...(data.providerRefundId !== undefined ? { providerRefundId: data.providerRefundId } : {}),
  };
  const [inserted] = await db
    .insert(refunds)
    .values(insert)
    .onConflictDoNothing({ target: [refunds.provider, refunds.idempotencyKey] })
    .returning();
  if (inserted !== undefined) return { row: inserted, created: true };

  const existing = await findByProviderAndKey(db, {
    provider: data.provider,
    idempotencyKey: data.idempotencyKey,
  });
  if (existing === undefined) {
    // The conflict fired, so a row with this key exists; not finding it means the
    // target of the conflict was some other constraint entirely.
    throw new Error("createRefund: conflicting row could not be read back");
  }
  return { row: existing, created: false };
}

export async function findByProviderAndKey(
  db: DbOrTx,
  opts: { provider: string; idempotencyKey: string },
): Promise<Refund | undefined> {
  const [row] = await db
    .select()
    .from(refunds)
    .where(
      and(eq(refunds.provider, opts.provider), eq(refunds.idempotencyKey, opts.idempotencyKey)),
    )
    .limit(1);
  return row;
}

/**
 * Find the refund an inbound provider webhook is about.
 *
 * This is the match a refund webhook needs: the provider names its own refund,
 * and that name is the only thing tying the event to one of several partial
 * refunds on the same payment.
 */
export async function findByProviderRefundId(
  db: DbOrTx,
  opts: { provider: string; providerRefundId: string },
): Promise<Refund | undefined> {
  const [row] = await db
    .select()
    .from(refunds)
    .where(
      and(eq(refunds.provider, opts.provider), eq(refunds.providerRefundId, opts.providerRefundId)),
    )
    .limit(1);
  return row;
}

/** Every refund recorded against one payment, newest state included. */
export async function listByTransaction(db: DbOrTx, transactionId: string): Promise<Refund[]> {
  return db.select().from(refunds).where(eq(refunds.transactionId, transactionId));
}

/**
 * The refunded total for one payment: the sum of refunds that actually moved
 * money. Derived on read so it cannot disagree with the rows.
 *
 * Returned as a string because it is a NUMERIC sum; the caller parses it with the
 * money helpers rather than through `Number`.
 */
export async function sumSucceededByTransaction(
  db: DbOrTx,
  opts: { transactionId: string; currencyCode: string },
): Promise<string> {
  const [row] = await db
    .select({ totalMicros: sql<string>`COALESCE(SUM(${refunds.amountMicros}), 0)::text` })
    .from(refunds)
    .where(
      and(
        eq(refunds.transactionId, opts.transactionId),
        eq(refunds.currencyCode, opts.currencyCode),
        eq(refunds.status, "succeeded"),
      ),
    );
  return row?.totalMicros ?? "0";
}

/**
 * Sum of refunds that have not resolved yet — money already claimed but not yet
 * moved. Counted against the refundable remainder so two concurrent requests
 * cannot each be told there is room for the full balance.
 */
export async function sumOpenByTransaction(
  db: DbOrTx,
  opts: { transactionId: string; currencyCode: string },
): Promise<string> {
  const [row] = await db
    .select({ totalMicros: sql<string>`COALESCE(SUM(${refunds.amountMicros}), 0)::text` })
    .from(refunds)
    .where(
      and(
        eq(refunds.transactionId, opts.transactionId),
        eq(refunds.currencyCode, opts.currencyCode),
        inArray(refunds.status, [...OPEN_STATUSES]),
      ),
    );
  return row?.totalMicros ?? "0";
}

/** Provider accepted the request and named the refund. */
export async function markSubmitted(
  db: DbOrTx,
  opts: { refundId: string; providerRefundId?: string },
): Promise<Refund | undefined> {
  const patch: Record<string, unknown> = { status: "submitted", updatedAt: new Date() };
  if (opts.providerRefundId !== undefined) patch.providerRefundId = opts.providerRefundId;
  const [row] = await db
    .update(refunds)
    .set(patch)
    .where(and(eq(refunds.refundId, opts.refundId), inArray(refunds.status, ["requested"])))
    .returning();
  return row;
}

/** Provider accepted the request but confirms out of band, via webhook. */
export async function markPendingWebhook(
  db: DbOrTx,
  opts: { refundId: string; providerRefundId?: string },
): Promise<Refund | undefined> {
  const patch: Record<string, unknown> = { status: "pending_webhook", updatedAt: new Date() };
  if (opts.providerRefundId !== undefined) patch.providerRefundId = opts.providerRefundId;
  const [row] = await db
    .update(refunds)
    .set(patch)
    .where(
      and(eq(refunds.refundId, opts.refundId), inArray(refunds.status, ["requested", "submitted"])),
    )
    .returning();
  return row;
}

/**
 * The money moved: record the ledger row that moved it.
 *
 * Guarded on the refund still being open. That guard is the exactly-once gate for
 * the payout — a provider that redelivers its refund webhook, or a reconciler
 * racing that webhook, gets `undefined` here and must not touch the balance. The
 * ledger's unique index is the second line of defence, not the first.
 */
export async function markSucceeded(
  db: DbOrTx,
  opts: {
    refundId: string;
    ledgerEntryId: string;
    providerRefundId?: string;
    now?: Date;
  },
): Promise<Refund | undefined> {
  const now = opts.now ?? new Date();
  const patch: Record<string, unknown> = {
    status: "succeeded",
    ledgerEntryId: opts.ledgerEntryId,
    succeededAt: now,
    updatedAt: now,
  };
  if (opts.providerRefundId !== undefined) patch.providerRefundId = opts.providerRefundId;
  const [row] = await db
    .update(refunds)
    .set(patch)
    .where(and(eq(refunds.refundId, opts.refundId), inArray(refunds.status, [...OPEN_STATUSES])))
    .returning();
  return row;
}

/**
 * The provider refused, or the attempt failed. Terminal, and it frees the
 * headroom the open refund was holding.
 */
export async function markFailed(
  db: DbOrTx,
  opts: {
    refundId: string;
    failureCode: string;
    failureMessage?: string;
    now?: Date;
  },
): Promise<Refund | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(refunds)
    .set({
      status: "failed",
      failureCode: opts.failureCode,
      failureMessage: opts.failureMessage ?? null,
      updatedAt: now,
    })
    .where(and(eq(refunds.refundId, opts.refundId), inArray(refunds.status, [...OPEN_STATUSES])))
    .returning();
  return row;
}

/**
 * Paykit itself refused the request — over the refundable remainder, wrong
 * currency, payment not refundable. Distinct from `failed` because no provider
 * call was ever made, which is what someone diagnosing it needs to know first.
 */
export async function markRejected(
  db: DbOrTx,
  opts: { refundId: string; failureCode: string; failureMessage?: string; now?: Date },
): Promise<Refund | undefined> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(refunds)
    .set({
      status: "rejected",
      failureCode: opts.failureCode,
      failureMessage: opts.failureMessage ?? null,
      updatedAt: now,
    })
    .where(and(eq(refunds.refundId, opts.refundId), inArray(refunds.status, [...OPEN_STATUSES])))
    .returning();
  return row;
}
