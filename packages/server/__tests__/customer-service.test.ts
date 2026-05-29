/**
 * customer-service tests with mock DbOrTx + in-memory provider port.
 * Covers RT F4 dedup paths + RT 15g email-source-of-truth contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCustomerService,
  CustomerTenantMismatchError,
  type CustomerProviderPort,
} from "../src/services/customer-service.js";

interface CustomerRow {
  tenantId: string;
  provider: string;
  providerCustomerId: string;
  email?: string;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal Drizzle-shaped DB stub. Only models the methods customer.repo uses:
 *   - select().from().where().limit()
 *   - insert().values().onConflictDoNothing().returning()
 *   - delete().where()
 */
function buildDbStub() {
  const rows: CustomerRow[] = [];
  const insertSpy = vi.fn();

  const findOne = (predicate: (r: CustomerRow) => boolean) => rows.find(predicate);

  function select() {
    const builder = {
      from: () => builder,
      where: (clause: unknown) => {
        const pred = (clause as { __pred?: (r: CustomerRow) => boolean }).__pred;
        return {
          limit: async () => (pred ? (rows.filter(pred).slice(0, 1) as CustomerRow[]) : rows),
        };
      },
    };
    return builder;
  }
  function insert() {
    let pendingValues: Partial<CustomerRow> | null = null;
    return {
      values(v: Partial<CustomerRow>) {
        pendingValues = v;
        return this;
      },
      onConflictDoNothing() {
        return this;
      },
      async returning() {
        if (!pendingValues) return [];
        insertSpy(pendingValues);
        const exists = findOne(
          (r) => r.tenantId === pendingValues!.tenantId && r.provider === pendingValues!.provider,
        );
        if (exists) return [];
        const row: CustomerRow = {
          tenantId: pendingValues.tenantId!,
          provider: pendingValues.provider!,
          providerCustomerId: pendingValues.providerCustomerId!,
          metadataJson: (pendingValues.metadataJson ?? {}) as Record<string, unknown>,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(pendingValues.email !== undefined ? { email: pendingValues.email } : {}),
        };
        rows.push(row);
        return [row];
      },
    };
  }

  // The repo passes a Drizzle expression; our select() reads `__pred` from the
  // SQL clause so we can substitute equality logic in tests. Pass-through that:
  const eq = (col: { __field: keyof CustomerRow }, val: unknown) => ({
    __pred: (r: CustomerRow) => r[col.__field] === val,
  });
  const and = (...clauses: Array<{ __pred: (r: CustomerRow) => boolean }>) => ({
    __pred: (r: CustomerRow) => clauses.every((c) => c.__pred(r)),
  });

  return {
    rows,
    insertSpy,
    db: { select, insert, delete: vi.fn() },
    eq,
    and,
  };
}

// Replace drizzle-orm's eq/and bound by the repo with our test stubs by
// shadowing through vi.mock — the repo imports from "drizzle-orm" so we
// intercept there to keep tests purely in-memory.
vi.mock("drizzle-orm", async () => {
  const eq = (col: unknown, val: unknown) => ({
    __pred: (r: Record<string, unknown>) => {
      const fieldName = (col as { name?: string }).name;
      if (!fieldName) return false;
      const camel = fieldName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      return r[camel] === val;
    },
  });
  const and = (...clauses: Array<{ __pred: (r: Record<string, unknown>) => boolean }>) => ({
    __pred: (r: Record<string, unknown>) => clauses.every((c) => c.__pred(r)),
  });
  return { eq, and };
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeProviderPort(stripeCustomers: Map<string, { metadata: Record<string, string> }>): {
  port: CustomerProviderPort;
  createSpy: ReturnType<typeof vi.fn>;
  retrieveSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async (input: { tenantId: string; idempotencyKey: string }) => {
    // Stripe behavior: same idempotency_key returns same customer
    const existing = [...stripeCustomers.entries()].find(
      ([, c]) => c.metadata.idempotency_key === input.idempotencyKey,
    );
    if (existing) {
      return { providerCustomerId: existing[0], metadata: existing[1].metadata };
    }
    const id = `cus_${Math.random().toString(36).slice(2, 10)}`;
    const metadata = { idempotency_key: input.idempotencyKey, paykit_tenant_id: input.tenantId };
    stripeCustomers.set(id, { metadata });
    return { providerCustomerId: id, metadata };
  });
  const retrieveSpy = vi.fn(async (id: string) => {
    const c = stripeCustomers.get(id);
    if (!c) return null;
    return { id, metadata: c.metadata };
  });
  return {
    port: {
      id: "stripe-subscription",
      createCustomer: createSpy,
      retrieveCustomer: retrieveSpy,
    },
    createSpy,
    retrieveSpy,
  };
}

describe("customer-service cache hit (no Stripe call)", () => {
  it("returns cached row without invoking provider.createCustomer", async () => {
    const { db, rows } = buildDbStub();
    rows.push({
      tenantId: "t-1",
      provider: "stripe-subscription",
      providerCustomerId: "cus_existing",
      metadataJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stripeCustomers = new Map();
    const { port, createSpy } = makeProviderPort(stripeCustomers);
    const svc = buildCustomerService({ db: db as never, provider: port });
    const id = await svc.getOrCreateCustomer({ tenantId: "t-1" });
    expect(id).toBe("cus_existing");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("customer-service lazy create (RT F4)", () => {
  it("creates Stripe customer with paykit:customer:{provider}:{tenantId} idempotency key", async () => {
    const { db } = buildDbStub();
    const stripeCustomers = new Map();
    const { port, createSpy } = makeProviderPort(stripeCustomers);
    const svc = buildCustomerService({ db: db as never, provider: port });

    const id = await svc.getOrCreateCustomer({ tenantId: "t-2", email: "u@example.com" });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0]?.[0] as { idempotencyKey: string; email?: string };
    expect(call.idempotencyKey).toBe("paykit:customer:stripe-subscription:t-2");
    expect(call.email).toBe("u@example.com");
    expect(id).toMatch(/^cus_/);
  });
});

describe("customer-service concurrent create (RT F4)", () => {
  it("two parallel calls produce SAME customer id (Stripe idempotency dedups)", async () => {
    const { db } = buildDbStub();
    const stripeCustomers = new Map();
    const { port, createSpy } = makeProviderPort(stripeCustomers);
    const svc = buildCustomerService({ db: db as never, provider: port });

    const [a, b] = await Promise.all([
      svc.getOrCreateCustomer({ tenantId: "t-3" }),
      svc.getOrCreateCustomer({ tenantId: "t-3" }),
    ]);

    expect(a).toBe(b);
    // Both calls reach Stripe but Stripe collapses on idempotency_key →
    // single customer in stripe-side store. No orphan.
    expect(stripeCustomers.size).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});

describe("customer-service linkExistingCustomer metadata integrity (RT F4)", () => {
  it("rejects when Stripe customer.metadata.paykit_tenant_id does NOT match", async () => {
    const { db } = buildDbStub();
    const stripeCustomers = new Map<string, { metadata: Record<string, string> }>();
    stripeCustomers.set("cus_other_tenant", {
      metadata: { paykit_tenant_id: "tenant-OTHER" },
    });
    const { port } = makeProviderPort(stripeCustomers);
    const svc = buildCustomerService({ db: db as never, provider: port });

    await expect(
      svc.linkExistingCustomer("tenant-MINE", "cus_other_tenant"),
    ).rejects.toBeInstanceOf(CustomerTenantMismatchError);
  });

  it("accepts when metadata matches, persists row", async () => {
    const { db, rows } = buildDbStub();
    const stripeCustomers = new Map<string, { metadata: Record<string, string> }>();
    stripeCustomers.set("cus_legit", { metadata: { paykit_tenant_id: "t-9" } });
    const { port } = makeProviderPort(stripeCustomers);
    const svc = buildCustomerService({ db: db as never, provider: port });

    await svc.linkExistingCustomer("t-9", "cus_legit");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerCustomerId).toBe("cus_legit");
  });
});
