/**
 * payment.repo — CRUD for paykit.payment_transactions.
 * Routes use these helpers; webhook/checkout transaction wraps pass `tx`.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DbClient, DbOrTx } from "../client.js";
import {
  type NewPaymentTransaction,
  type PaymentStatus,
  type PaymentTransaction,
  paymentTransactions,
} from "../schema/payment-transactions.js";

export interface CreateTransactionInput {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly providerRef?: string;
  readonly idempotencyKey?: string;
  readonly metadataJson?: Record<string, unknown>;
}

export async function createTransaction(
  db: DbOrTx,
  data: CreateTransactionInput,
): Promise<PaymentTransaction> {
  const insert: NewPaymentTransaction = {
    tenantId: data.tenantId,
    ownerId: data.ownerId,
    provider: data.provider,
    amountMicros: data.amountMicros,
    currencyCode: data.currencyCode,
    metadataJson: data.metadataJson ?? {},
  };
  if (data.providerRef !== undefined) {
    (insert as { providerRef?: string }).providerRef = data.providerRef;
  }
  if (data.idempotencyKey !== undefined) {
    (insert as { idempotencyKey?: string }).idempotencyKey = data.idempotencyKey;
  }
  const [row] = await db.insert(paymentTransactions).values(insert).returning();
  if (!row) throw new Error("createTransaction: INSERT RETURNING produced no row");
  return row;
}

export async function findByIdempotencyKey(
  db: DbClient,
  tenantId: string,
  key: string,
): Promise<PaymentTransaction | undefined> {
  return db.query.paymentTransactions.findFirst({
    where: and(
      eq(paymentTransactions.idempotencyKey, key),
      eq(paymentTransactions.tenantId, tenantId),
    ),
  });
}

// WARNING: not tenant-scoped. (provider, provider_ref) is globally unique, so a
// lookup can return a row owned by another tenant. Safe only for trusted
// server-side paths (e.g. webhook routing keyed on the provider's own ref).
// Never expose this behind a tenant-facing request without adding a tenantId guard.
export async function findByProviderRef(
  db: DbClient,
  provider: string,
  providerRef: string,
): Promise<PaymentTransaction | undefined> {
  return db.query.paymentTransactions.findFirst({
    where: and(
      eq(paymentTransactions.provider, provider),
      eq(paymentTransactions.providerRef, providerRef),
    ),
  });
}

export async function updateTransactionStatus(
  db: DbOrTx,
  transactionId: string,
  status: PaymentStatus,
  providerRef?: string,
): Promise<PaymentTransaction | undefined> {
  const update: { status: typeof status; updatedAt: Date; providerRef?: string } = {
    status,
    updatedAt: new Date(),
  };
  if (providerRef !== undefined) update.providerRef = providerRef;
  const [row] = await db
    .update(paymentTransactions)
    .set(update)
    .where(eq(paymentTransactions.transactionId, transactionId))
    .returning();
  return row;
}

export async function listByTenant(
  db: DbClient,
  tenantId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<PaymentTransaction[]> {
  return db.query.paymentTransactions.findMany({
    where: eq(paymentTransactions.tenantId, tenantId),
    orderBy: [desc(paymentTransactions.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  });
}

/**
 * Claim a checkout for an idempotency key, or hand back the claim that already
 * owns it.
 *
 * `created: false` means this key already has a payment row, and the caller must
 * NOT create a provider session for it — it either replays the stored result or
 * reports the checkout as still in progress. Doing this as an insert-first
 * conflict rather than a read-then-insert is what makes two concurrent requests
 * with the same key produce one checkout: the loser of the INSERT sees the
 * winner's row instead of a unique-violation 500, which left the key permanently
 * unusable.
 *
 * The row is created in `provider_creating`, before any provider call. That is the
 * durable record that a session MIGHT exist upstream, which is what lets a crash
 * mid-call be reconciled instead of silently losing a live checkout.
 */
export async function claimCheckout(
  db: DbOrTx,
  data: CreateTransactionInput,
): Promise<{ readonly row: PaymentTransaction; readonly created: boolean }> {
  const insert: NewPaymentTransaction = {
    tenantId: data.tenantId,
    ownerId: data.ownerId,
    provider: data.provider,
    amountMicros: data.amountMicros,
    currencyCode: data.currencyCode,
    status: "provider_creating" satisfies PaymentStatus,
    metadataJson: data.metadataJson ?? {},
  };
  if (data.providerRef !== undefined) {
    (insert as { providerRef?: string }).providerRef = data.providerRef;
  }
  if (data.idempotencyKey !== undefined) {
    (insert as { idempotencyKey?: string }).idempotencyKey = data.idempotencyKey;
  }

  // Without a key there is nothing to collide on, so there is no claim to
  // contend for and a plain insert is correct.
  if (data.idempotencyKey === undefined) {
    const [row] = await db.insert(paymentTransactions).values(insert).returning();
    if (!row) throw new Error("claimCheckout: INSERT RETURNING produced no row");
    return { row, created: true };
  }

  const [won] = await db
    .insert(paymentTransactions)
    .values(insert)
    .onConflictDoNothing({
      target: [paymentTransactions.tenantId, paymentTransactions.idempotencyKey],
    })
    .returning();
  if (won !== undefined) return { row: won, created: true };

  const [existing] = await db
    .select()
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.tenantId, data.tenantId),
        eq(paymentTransactions.idempotencyKey, data.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing === undefined) {
    throw new Error("claimCheckout: conflicting row could not be read back");
  }
  return { row: existing, created: false };
}

/**
 * Record the provider's answer and move the checkout to awaiting payment.
 *
 * Guarded on the row still being `provider_creating`, so only the request that
 * claimed it can finalize it: a slow duplicate cannot overwrite the reference of
 * a session that is already live.
 *
 * `checkoutResult` is stored whole because it is exactly what a replay of this key
 * has to return. It gets its own column rather than a corner of `metadata_json`
 * because other paths rewrite that column and would drop fields they have no
 * reason to know are load-bearing.
 */
export async function finalizeCheckout(
  db: DbOrTx,
  opts: {
    transactionId: string;
    providerRef: string;
    checkoutResult: Record<string, unknown>;
    metadataJson?: Record<string, unknown>;
  },
): Promise<PaymentTransaction | undefined> {
  const patch: Record<string, unknown> = {
    status: "awaiting_payment" satisfies PaymentStatus,
    providerRef: opts.providerRef,
    checkoutResultJson: opts.checkoutResult,
    updatedAt: new Date(),
  };
  if (opts.metadataJson !== undefined) patch.metadataJson = opts.metadataJson;
  const [row] = await db
    .update(paymentTransactions)
    .set(patch)
    .where(
      and(
        eq(paymentTransactions.transactionId, opts.transactionId),
        eq(paymentTransactions.status, "provider_creating"),
      ),
    )
    .returning();
  return row;
}

/**
 * Abandon a claim whose provider call failed, so the key can be retried instead
 * of being stuck in `provider_creating` until someone reconciles it.
 *
 * Guarded on `provider_creating` for the same reason as the finalize. Deleting
 * rather than marking failed is deliberate: the row holds the unique idempotency
 * key, and a failed attempt that never reached the provider should leave the key
 * as usable as it was before.
 */
export async function abandonCheckoutClaim(db: DbOrTx, transactionId: string): Promise<boolean> {
  const deleted = await db
    .delete(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.transactionId, transactionId),
        eq(paymentTransactions.status, "provider_creating"),
      ),
    )
    .returning({ transactionId: paymentTransactions.transactionId });
  return deleted.length > 0;
}
