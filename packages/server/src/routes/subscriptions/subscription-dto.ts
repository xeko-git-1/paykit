/**
 * Subscription serializer + tenant-scope helpers shared by tenant + admin
 * route files. Keeps each route under 200 LOC.
 */
import type { SubscriptionStatus } from "@vibecc/paykit";
import type { Subscription } from "../../db/schema/subscriptions.js";

export interface SubscriptionDto {
  readonly id: string;
  readonly tenantId: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly customerId: string;
  readonly priceId: string;
  readonly latestInvoiceId: string | null;
  readonly currencyCode: string;
  readonly provider: string;
  readonly providerSubscriptionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toDto(row: Subscription): SubscriptionDto {
  return {
    id: row.subscriptionId,
    tenantId: row.tenantId,
    status: row.status as SubscriptionStatus,
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    customerId: row.customerId,
    priceId: row.priceId,
    latestInvoiceId: row.latestInvoiceId,
    currencyCode: row.currencyCode,
    provider: row.provider,
    providerSubscriptionId: row.providerSubscriptionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const ALL_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "incomplete",
  "unpaid",
  "incomplete_expired",
  "paused",
];

export function parseStatusFilter(raw: string | undefined): readonly SubscriptionStatus[] | null {
  if (raw === undefined || raw === "") return null;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const valid: SubscriptionStatus[] = [];
  for (const p of parts) {
    if ((ALL_STATUSES as readonly string[]).includes(p)) valid.push(p as SubscriptionStatus);
  }
  return valid.length === 0 ? [] : valid;
}
