/**
 * V1.5 → V2 customer backfill (RT F13).
 *
 * Idempotent. Reads V1.5 `payment_transactions` rows where the metadata
 * carries a Stripe customer id (set by `@vibecc/paykit-stripe` since V1)
 * and UPSERTs into `paykit.customers`. Re-running produces zero new rows.
 *
 * Used during V1.5 → V2 upgrade so the first V2 subscribe call doesn't
 * orphan an existing Stripe customer per tenant.
 */
import {
  customerRepo,
  type DbClient,
  paymentTransactions,
} from "@vibecc/paykit-server";
import { eq } from "drizzle-orm";

export interface BackfillCustomersInput {
  readonly db: DbClient;
  readonly providerId: string;
  readonly limit?: number;
  readonly logger?: { info: (msg: string, details?: Record<string, unknown>) => void };
}

export interface BackfillCustomersResult {
  readonly scanned: number;
  readonly inserted: number;
  readonly skipped: number;
}

interface PaykitV15Metadata {
  readonly stripeCustomerId?: string;
  readonly customerId?: string;
  readonly customerEmail?: string;
}

export async function backfillCustomers(
  input: BackfillCustomersInput,
): Promise<BackfillCustomersResult> {
  const { db, providerId, limit = 10_000 } = input;
  const rows = await db
    .select()
    .from(paymentTransactions)
    .where(eq(paymentTransactions.provider, "stripe"))
    .limit(limit);

  let inserted = 0;
  let skipped = 0;
  for (const tx of rows) {
    const meta = (tx.metadataJson ?? {}) as PaykitV15Metadata;
    const stripeCustomerId = meta.stripeCustomerId ?? meta.customerId;
    if (!stripeCustomerId) {
      skipped++;
      continue;
    }
    const before = await customerRepo.findCustomer(db, tx.tenantId, providerId);
    if (before) {
      skipped++;
      continue;
    }
    await customerRepo.getOrInsertCustomer(db, {
      tenantId: tx.tenantId,
      provider: providerId,
      providerCustomerId: stripeCustomerId,
      ...(meta.customerEmail !== undefined ? { email: meta.customerEmail } : {}),
      metadata: { backfilledFrom: "v1.5_payment_transactions" },
    });
    inserted++;
  }

  input.logger?.info("backfill_customers_complete", {
    provider: providerId,
    scanned: rows.length,
    inserted,
    skipped,
  });
  return { scanned: rows.length, inserted, skipped };
}
