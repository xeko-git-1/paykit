/**
 * tenant-currency.repo — read/write the tenant's default checkout currency.
 *
 * The preference is consulted once per generic-style checkout that omits
 * `currency`, and only then — the routers defer the lookup so requests that
 * name their currency (or use the legacy amountUsd/amountVnd fields) never
 * pay for it.
 *
 * Validation of the code against the currency registry happens in the caller
 * (the registry lives in @xeko-git-1/paykit and this package does not depend
 * on it); the database enforces only the ISO-4217 shape.
 */
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import {
  type TenantCurrencyPreference,
  tenantCurrencyPreferences,
} from "../schema/tenant-currency-preferences.js";

export async function findByTenantId(
  db: DbOrTx,
  tenantId: string,
): Promise<TenantCurrencyPreference | null> {
  const rows = await db
    .select()
    .from(tenantCurrencyPreferences)
    .where(eq(tenantCurrencyPreferences.tenantId, tenantId))
    .limit(1);
  return rows[0] ?? null;
}

/** Set (or replace) the tenant's default currency. Returns the stored row. */
export async function upsertPreference(
  db: DbOrTx,
  opts: { tenantId: string; currencyCode: string },
): Promise<TenantCurrencyPreference> {
  const rows = await db
    .insert(tenantCurrencyPreferences)
    .values({ tenantId: opts.tenantId, currencyCode: opts.currencyCode })
    .onConflictDoUpdate({
      target: tenantCurrencyPreferences.tenantId,
      set: {
        currencyCode: sql`excluded.currency_code`,
        updatedAt: new Date(),
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error("tenant-currency.repo.upsertPreference: upsert returned no row");
  }
  return row;
}
