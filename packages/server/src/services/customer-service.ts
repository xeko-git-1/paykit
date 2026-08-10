/**
 * customer-service — V2 Phase 04. Maps tenant_id → Stripe customer id with
 * lazy-create + idempotent dedup at BOTH layers (RT F4):
 *
 *   1. Stripe-side: idempotency_key = "paykit:customer:${provider}:${tenantId}"
 *      forwarded to stripe.customers.create. Concurrent calls collapse to a
 *      single Stripe customer.
 *   2. Paykit-side: paykit.customers PK (tenant_id, provider) catches the
 *      losing concurrent inserter via ON CONFLICT DO NOTHING.
 *
 * Stripe is source-of-truth for email + customer state; we never push email
 * updates back (RT 15g). The optional metadata-tenant integrity check is
 * exposed for V2.1 multi-instance "link existing customer" flows.
 */
import type { DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import * as customerRepo from "@xeko-git-1/paykit-auth-core/db/repos/customer.repo.js";

export class CustomerTenantMismatchError extends Error {
  constructor(message = "Stripe customer.metadata.paykitTenantId does not match request tenant") {
    super(message);
    this.name = "CustomerTenantMismatchError";
  }
}

export interface ProviderCustomerCreateInput {
  readonly tenantId: string;
  readonly provider: string;
  readonly email?: string;
  readonly idempotencyKey: string;
}

export interface ProviderCustomerCreateResult {
  readonly providerCustomerId: string;
  readonly metadata?: Record<string, string>;
}

export interface ProviderCustomerLookupResult {
  readonly id: string;
  readonly metadata: Record<string, string>;
}

export interface CustomerProviderPort {
  readonly id: string;
  createCustomer(input: ProviderCustomerCreateInput): Promise<ProviderCustomerCreateResult>;
  retrieveCustomer?(providerCustomerId: string): Promise<ProviderCustomerLookupResult | null>;
}

export interface GetOrCreateInput {
  readonly tenantId: string;
  readonly email?: string;
}

export function buildCustomerService(deps: {
  readonly db: DbOrTx;
  readonly provider: CustomerProviderPort;
}): {
  getOrCreateCustomer(input: GetOrCreateInput): Promise<string>;
  linkExistingCustomer(tenantId: string, providerCustomerId: string): Promise<void>;
} {
  const { db, provider } = deps;

  async function getOrCreateCustomer(input: GetOrCreateInput): Promise<string> {
    const cached = await customerRepo.findCustomer(db, input.tenantId, provider.id);
    if (cached) return cached.providerCustomerId;

    const idempotencyKey = `paykit:customer:${provider.id}:${input.tenantId}`;
    const created = await provider.createCustomer({
      tenantId: input.tenantId,
      provider: provider.id,
      idempotencyKey,
      ...(input.email !== undefined ? { email: input.email } : {}),
    });

    const upserted = await customerRepo.getOrInsertCustomer(db, {
      tenantId: input.tenantId,
      provider: provider.id,
      providerCustomerId: created.providerCustomerId,
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(created.metadata !== undefined ? { metadata: created.metadata } : {}),
    });
    return upserted.providerCustomerId;
  }

  async function linkExistingCustomer(tenantId: string, providerCustomerId: string): Promise<void> {
    if (!provider.retrieveCustomer) {
      throw new Error(
        `Provider ${provider.id} does not support linking existing customers (V2.1 path)`,
      );
    }
    const remote = await provider.retrieveCustomer(providerCustomerId);
    if (!remote) {
      throw new CustomerTenantMismatchError(
        `Customer ${providerCustomerId} not found at provider ${provider.id}`,
      );
    }
    if (remote.metadata.paykit_tenant_id !== tenantId) {
      throw new CustomerTenantMismatchError();
    }
    await customerRepo.getOrInsertCustomer(db, {
      tenantId,
      provider: provider.id,
      providerCustomerId,
      metadata: remote.metadata,
    });
  }

  return { getOrCreateCustomer, linkExistingCustomer };
}
