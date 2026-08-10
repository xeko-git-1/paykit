/**
 * subscription.repo — V2. Subscription cache CRUD + last-write-wins UPSERT.
 *
 * Stripe is source of truth; this repo caches the latest known shape.
 * Webhook handlers MUST go through `upsertFromEvent` so out-of-order events
 * don't roll back state — predicate `EXCLUDED.last_event_created > subscriptions.last_event_created`
 * enforces RT F9.
 *
 * `markCanceled` is webhook-only path used by customer.deleted cascade and
 * sub.deleted; it bumps last_event_created to enforce ordering.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { type NewSubscription, type Subscription, subscriptions } from "../schema/subscriptions.js";

export interface UpsertSubscriptionInput {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly providerSubscriptionId: string;
  readonly customerId: string;
  readonly priceId: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly latestInvoiceId?: string;
  readonly lastEventCreated: Date;
  readonly metadata?: Record<string, unknown>;
}

/**
 * UPSERT with last-write-wins predicate (RT F9). Returns the post-write row,
 * or the existing row if the inbound event is older.
 */
export async function upsertFromEvent(
  db: DbOrTx,
  input: UpsertSubscriptionInput,
): Promise<Subscription> {
  const now = new Date();
  const metadataJson = input.metadata ?? {};
  const latestInvoiceId = input.latestInvoiceId ?? null;
  const insert: NewSubscription = {
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    provider: input.provider,
    providerSubscriptionId: input.providerSubscriptionId,
    customerId: input.customerId,
    priceId: input.priceId,
    status: input.status,
    currencyCode: input.currencyCode,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    lastEventCreated: input.lastEventCreated,
    metadataJson,
    updatedAt: now,
  };
  if (latestInvoiceId !== null) insert.latestInvoiceId = latestInvoiceId;

  const [row] = await db
    .insert(subscriptions)
    .values(insert)
    .onConflictDoUpdate({
      target: [subscriptions.provider, subscriptions.providerSubscriptionId],
      set: {
        priceId: input.priceId,
        status: input.status,
        currencyCode: input.currencyCode,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        latestInvoiceId,
        lastEventCreated: input.lastEventCreated,
        metadataJson,
        updatedAt: now,
      },
      setWhere: sql`subscriptions.last_event_created < EXCLUDED.last_event_created`,
    })
    .returning();
  if (row) return row;
  const existing = await findByProviderSub(db, input.provider, input.providerSubscriptionId);
  if (!existing) throw new Error("upsertFromEvent: post-conflict fetch returned null");
  return existing;
}

export async function findByProviderSub(
  db: DbOrTx,
  provider: string,
  providerSubscriptionId: string,
): Promise<Subscription | undefined> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, provider),
        eq(subscriptions.providerSubscriptionId, providerSubscriptionId),
      ),
    )
    .limit(1);
  return row;
}

export async function findById(
  db: DbOrTx,
  subscriptionId: string,
): Promise<Subscription | undefined> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.subscriptionId, subscriptionId))
    .limit(1);
  return row;
}

export async function listForTenant(
  db: DbOrTx,
  tenantId: string,
  opts: { statuses?: readonly string[]; limit?: number; offset?: number } = {},
): Promise<Subscription[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const conds = [eq(subscriptions.tenantId, tenantId)];
  if (opts.statuses && opts.statuses.length > 0) {
    conds.push(inArray(subscriptions.status, [...opts.statuses]));
  }
  return db
    .select()
    .from(subscriptions)
    .where(and(...conds))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(limit)
    .offset(offset);
}

export async function listByCustomer(
  db: DbOrTx,
  provider: string,
  customerId: string,
): Promise<Subscription[]> {
  return db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, provider), eq(subscriptions.customerId, customerId)))
    .orderBy(asc(subscriptions.createdAt));
}

export async function listActiveByCustomer(
  db: DbOrTx,
  provider: string,
  customerId: string,
): Promise<Subscription[]> {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.provider, provider),
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, ["active", "trialing", "past_due"]),
      ),
    );
}

export async function markCanceled(
  db: DbOrTx,
  provider: string,
  providerSubscriptionId: string,
  eventCreatedAt: Date,
): Promise<Subscription | undefined> {
  const [row] = await db
    .update(subscriptions)
    .set({ status: "canceled", lastEventCreated: eventCreatedAt, updatedAt: new Date() })
    .where(
      and(
        eq(subscriptions.provider, provider),
        eq(subscriptions.providerSubscriptionId, providerSubscriptionId),
        sql`${subscriptions.lastEventCreated} < ${eventCreatedAt}`,
      ),
    )
    .returning();
  return row;
}
