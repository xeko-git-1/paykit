/**
 * Tenancy contract. Consumer implements `TenantResolver` and passes it to
 * `createPaykit`. Paykit calls it on EVERY checkout + read route. Webhook
 * routes do NOT call it — webhook tenancy comes from the locked
 * `payment_transactions` row.
 */

export interface ResolvedTenant {
  readonly tenantId: string;
  readonly ownerId: string;
}

export type TenantResolver = (req: unknown) => ResolvedTenant | Promise<ResolvedTenant>;
