/**
 * balance.repo — multi-wallet balance projection. PK is (tenant_id, currency_code)
 * so the same tenant can hold USD + VND wallets independently.
 *
 * `applyDelta` adds (or subtracts via negative) micros to the per-currency
 * projection in a single UPSERT. No `CurrencyMismatchError` because the
 * compound PK isolates currencies — a non-existent (tenant, currency) row
 * is created with the new currency.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbClient, DbOrTx } from "../client.js";
import { type BalanceProjection, balanceProjections } from "../schema/balance-projections.js";

export async function getBalance(
  db: DbClient,
  tenantId: string,
  currencyCode: string,
): Promise<BalanceProjection | undefined> {
  return db.query.balanceProjections.findFirst({
    where: and(
      eq(balanceProjections.tenantId, tenantId),
      eq(balanceProjections.currencyCode, currencyCode),
    ),
  });
}

export async function listBalancesByTenant(
  db: DbClient,
  tenantId: string,
): Promise<BalanceProjection[]> {
  return db.query.balanceProjections.findMany({
    where: eq(balanceProjections.tenantId, tenantId),
  });
}

/**
 * Atomic upsert: insert (tenantId, currencyCode, deltaMicros) or add deltaMicros to existing.
 * Negative `deltaMicros` reduces balance (used for refund / debit).
 *
 * A resulting negative balance is a valid state, not an error: a chargeback or
 * refund can land after the merchant has already withdrawn funds. We therefore
 * do not clamp at zero or guard against underflow — the ledger is the source of
 * truth and a negative projection faithfully represents money owed.
 */
export async function applyDelta(
  db: DbOrTx,
  tenantId: string,
  currencyCode: string,
  deltaMicros: bigint,
): Promise<BalanceProjection> {
  const deltaStr = deltaMicros.toString();
  const [row] = await db
    .insert(balanceProjections)
    .values({
      tenantId,
      currencyCode,
      currentBalanceMicros: deltaStr,
    })
    .onConflictDoUpdate({
      target: [balanceProjections.tenantId, balanceProjections.currencyCode],
      set: {
        currentBalanceMicros: sql`${balanceProjections.currentBalanceMicros} + ${deltaStr}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("applyDelta: INSERT/UPDATE RETURNING produced no row");
  return row;
}
