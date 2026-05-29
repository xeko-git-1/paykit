/**
 * ledger.repo — append-only ledger writes + per-currency balance queries.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { DbClient, DbOrTx } from "../client.js";
import { type LedgerEntry, type NewLedgerEntry, ledgerEntries } from "../schema/ledger-entries.js";

export type LedgerEntryType =
  | "credit"
  | "debit"
  | "refund"
  | "manual_adjustment"
  | "subscription_credit"
  | "refund_debit"
  | "dispute_debit"
  | "credit_note_debit";

export interface AppendLedgerEntryInput {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly entryType: LedgerEntryType;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly provider?: string;
  readonly sourceId?: string;
  readonly metadataJson?: Record<string, unknown>;
}

export async function appendLedgerEntry(
  db: DbOrTx,
  data: AppendLedgerEntryInput,
): Promise<LedgerEntry> {
  const insert: NewLedgerEntry = {
    tenantId: data.tenantId,
    ownerId: data.ownerId,
    entryType: data.entryType,
    amountMicros: data.amountMicros,
    currencyCode: data.currencyCode,
    metadataJson: data.metadataJson ?? {},
  };
  if (data.provider !== undefined) (insert as { provider?: string }).provider = data.provider;
  if (data.sourceId !== undefined) (insert as { sourceId?: string }).sourceId = data.sourceId;
  const [row] = await db.insert(ledgerEntries).values(insert).returning();
  if (!row) throw new Error("appendLedgerEntry: INSERT RETURNING produced no row");
  return row;
}

/**
 * V2 dedup variant — leverages UNIQUE (provider, source_id, entry_type) from
 * migration 009. Returns existing row on conflict instead of throwing,
 * enabling Stripe-resend safety (RT F1).
 */
export async function appendLedgerEntryIdempotent(
  db: DbOrTx,
  data: AppendLedgerEntryInput & { provider: string; sourceId: string },
): Promise<{ row: LedgerEntry; inserted: boolean }> {
  const insert: NewLedgerEntry = {
    tenantId: data.tenantId,
    ownerId: data.ownerId,
    entryType: data.entryType,
    amountMicros: data.amountMicros,
    currencyCode: data.currencyCode,
    metadataJson: data.metadataJson ?? {},
  };
  (insert as { provider?: string }).provider = data.provider;
  (insert as { sourceId?: string }).sourceId = data.sourceId;
  const [row] = await db
    .insert(ledgerEntries)
    .values(insert)
    .onConflictDoNothing({
      target: [ledgerEntries.provider, ledgerEntries.sourceId, ledgerEntries.entryType],
    })
    .returning();
  if (row) return { row, inserted: true };
  const [existing] = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.provider, data.provider),
        eq(ledgerEntries.sourceId, data.sourceId),
        eq(ledgerEntries.entryType, data.entryType),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("appendLedgerEntryIdempotent: post-conflict fetch returned null");
  return { row: existing, inserted: false };
}

export interface ListLedgerOpts {
  readonly tenantId: string;
  readonly entryType?: LedgerEntryType;
  readonly currencyCode?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export async function listLedgerEntries(
  db: DbClient,
  opts: ListLedgerOpts,
): Promise<LedgerEntry[]> {
  const conditions = [eq(ledgerEntries.tenantId, opts.tenantId)];
  if (opts.entryType) conditions.push(eq(ledgerEntries.entryType, opts.entryType));
  if (opts.currencyCode) conditions.push(eq(ledgerEntries.currencyCode, opts.currencyCode));
  if (opts.since) conditions.push(gte(ledgerEntries.createdAt, opts.since));
  if (opts.until) conditions.push(lt(ledgerEntries.createdAt, opts.until));

  return db
    .select()
    .from(ledgerEntries)
    .where(and(...conditions))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

/**
 * Compute current balance per currency by summing ledger entries for a tenant.
 * Returns one row per currency held by the tenant.
 */
export async function computeBalancesByTenant(
  db: DbClient,
  tenantId: string,
): Promise<Array<{ currencyCode: string; totalMicros: string }>> {
  const rows = await db
    .select({
      currencyCode: ledgerEntries.currencyCode,
      totalMicros: sql<string>`COALESCE(SUM(${ledgerEntries.amountMicros}), 0)::text`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.tenantId, tenantId))
    .groupBy(ledgerEntries.currencyCode);
  return rows;
}
