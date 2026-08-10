/**
 * Phase 09 — V1.5 → V2 customer backfill (RT F13).
 *
 * Verifies:
 *   - reads V1.5 payment_transactions rows
 *   - derives Stripe customer id from metadata.stripeCustomerId | metadata.customerId
 *   - inserts paykit.customers rows under (tenantId, providerId)
 *   - re-running produces zero new rows (idempotent)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface CustomerRow {
  tenantId: string;
  provider: string;
  providerCustomerId: string;
  email?: string;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface PaymentTx {
  transactionId: string;
  tenantId: string;
  ownerId: string;
  provider: string;
  metadataJson: Record<string, unknown>;
}

const customerRows: CustomerRow[] = [];
const paymentTxRows: PaymentTx[] = [];

vi.mock("@xeko-git-1/paykit-server", () => ({
  paymentTransactions: { __table: "payment_transactions" },
  customerRepo: {
    findCustomer: vi.fn(async (_db: unknown, tenantId: string, provider: string) =>
      customerRows.find((r) => r.tenantId === tenantId && r.provider === provider),
    ),
    getOrInsertCustomer: vi.fn(
      async (
        _db: unknown,
        input: {
          tenantId: string;
          provider: string;
          providerCustomerId: string;
          email?: string;
          metadata?: Record<string, unknown>;
        },
      ) => {
        const existing = customerRows.find(
          (r) => r.tenantId === input.tenantId && r.provider === input.provider,
        );
        if (existing) return existing;
        const row: CustomerRow = {
          tenantId: input.tenantId,
          provider: input.provider,
          providerCustomerId: input.providerCustomerId,
          metadataJson: (input.metadata ?? {}) as Record<string, unknown>,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(input.email !== undefined ? { email: input.email } : {}),
        };
        customerRows.push(row);
        return row;
      },
    ),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: { name?: string }, val: unknown) => ({
    __pred: (r: Record<string, unknown>) => {
      const fieldName = col.name ?? "";
      const camel = fieldName.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
      return r[camel] === val || r[fieldName] === val;
    },
  }),
}));

const { backfillCustomers } = await import("../src/backfill/backfill-customers.js");

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

function buildDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => paymentTxRows.slice(0, n),
        }),
      }),
    }),
  } as never;
}

beforeEach(() => {
  customerRows.length = 0;
  paymentTxRows.length = 0;
});

describe("backfill-customers (RT F13)", () => {
  it("derives customers from V1.5 payment_transactions metadata", async () => {
    paymentTxRows.push(
      {
        transactionId: "t1",
        tenantId: TENANT_A,
        ownerId: TENANT_A,
        provider: "stripe",
        metadataJson: { stripeCustomerId: "cus_abc", customerEmail: "u@example.com" },
      },
      {
        transactionId: "t2",
        tenantId: TENANT_B,
        ownerId: TENANT_B,
        provider: "stripe",
        metadataJson: { customerId: "cus_def" },
      },
    );

    const result = await backfillCustomers({
      db: buildDb(),
      providerId: "stripe-subscription",
    });

    expect(result.scanned).toBe(2);
    expect(result.inserted).toBe(2);
    expect(customerRows).toHaveLength(2);
    expect(customerRows[0]?.providerCustomerId).toBe("cus_abc");
    expect(customerRows[0]?.email).toBe("u@example.com");
    expect(customerRows[0]?.metadataJson).toEqual({
      backfilledFrom: "v1.5_payment_transactions",
    });
  });

  it("is idempotent — re-running produces zero new rows", async () => {
    paymentTxRows.push({
      transactionId: "t1",
      tenantId: TENANT_A,
      ownerId: TENANT_A,
      provider: "stripe",
      metadataJson: { stripeCustomerId: "cus_abc" },
    });

    const first = await backfillCustomers({
      db: buildDb(),
      providerId: "stripe-subscription",
    });
    const second = await backfillCustomers({
      db: buildDb(),
      providerId: "stripe-subscription",
    });

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(customerRows).toHaveLength(1);
  });

  it("skips rows missing both stripeCustomerId and customerId", async () => {
    paymentTxRows.push({
      transactionId: "t1",
      tenantId: TENANT_A,
      ownerId: TENANT_A,
      provider: "stripe",
      metadataJson: { unrelated: "field" },
    });
    const result = await backfillCustomers({
      db: buildDb(),
      providerId: "stripe-subscription",
    });
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(customerRows).toHaveLength(0);
  });
});
