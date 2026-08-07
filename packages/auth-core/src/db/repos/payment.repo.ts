/**
 * payment.repo — CRUD for paykit.payment_transactions.
 * Routes use these helpers; webhook/checkout transaction wraps pass `tx`.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DbClient, DbOrTx } from "../client.js";
import {
  type NewPaymentTransaction,
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
  status:
    | "pending"
    | "completed"
    | "failed"
    | "refunded"
    | "partially_refunded"
    | "expired"
    | "quarantine"
    | "refund_pending_webhook",
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
