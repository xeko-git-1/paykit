/**
 * customer.repo — V2. Lazy upsert of (tenant_id, provider) → Stripe customer.
 *
 * `getOrInsert` returns the existing row if present, otherwise inserts a
 * caller-supplied provider_customer_id. Phase 04 customer service is the
 * canonical writer; reconciler uses repo's read-only helpers.
 */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type Customer, type NewCustomer, customers } from "../schema/customers.js";

export interface UpsertCustomerInput {
  readonly tenantId: string;
  readonly provider: string;
  readonly providerCustomerId: string;
  readonly email?: string;
  readonly metadata?: Record<string, unknown>;
}

export async function findCustomer(
  db: DbOrTx,
  tenantId: string,
  provider: string,
): Promise<Customer | undefined> {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.provider, provider)))
    .limit(1);
  return row;
}

export async function findByProviderCustomerId(
  db: DbOrTx,
  provider: string,
  providerCustomerId: string,
): Promise<Customer | undefined> {
  const [row] = await db
    .select()
    .from(customers)
    .where(
      and(eq(customers.provider, provider), eq(customers.providerCustomerId, providerCustomerId)),
    )
    .limit(1);
  return row;
}

export async function getOrInsertCustomer(
  db: DbOrTx,
  input: UpsertCustomerInput,
): Promise<Customer> {
  const insert: NewCustomer = {
    tenantId: input.tenantId,
    provider: input.provider,
    providerCustomerId: input.providerCustomerId,
    metadataJson: input.metadata ?? {},
  };
  if (input.email !== undefined) insert.email = input.email;
  const [row] = await db
    .insert(customers)
    .values(insert)
    .onConflictDoNothing({ target: [customers.tenantId, customers.provider] })
    .returning();
  if (row) return row;
  const existing = await findCustomer(db, input.tenantId, input.provider);
  if (!existing) throw new Error("getOrInsertCustomer: idempotent fetch returned null");
  return existing;
}

export async function deleteCustomerForCascade(
  db: DbOrTx,
  provider: string,
  providerCustomerId: string,
): Promise<void> {
  await db
    .delete(customers)
    .where(
      and(eq(customers.provider, provider), eq(customers.providerCustomerId, providerCustomerId)),
    );
}
