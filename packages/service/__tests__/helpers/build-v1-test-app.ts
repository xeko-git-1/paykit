/**
 * Shared test helper — builds a service app with configurable mock deps
 * for testing /v1 endpoints with auth context injection.
 */
import type { PaymentProviderAdapter, ProviderRegistry } from "@vibecc/paykit";
import type { PaykitAuthContext } from "@vibecc/paykit-server";
import { Hono } from "hono";
import { buildV1Router, type V1RouterDeps } from "../../src/v1/router.js";
import { resetAllBuckets } from "../../src/v1/rate-limit.js";
import { getOpenAPIDocument } from "../../src/v1/openapi.js";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

export function createMockAdapter(id = "sepay"): PaymentProviderAdapter {
  return {
    id,
    supportedCurrencies: ["VND"],
    checkoutMode: "qr" as const,
    createCheckout: async () => ({
      providerSessionId: "mock-session-123",
      webUrl: "https://pay.example.com/session/123",
      expiresAt: new Date(Date.now() + 3600_000),
    }),
    parseWebhookPayload: async () => null,
    verifyWebhookSignature: async () => true,
    refund: async () => ({ state: "completed" as const, providerRefundId: "ref-123" }),
    fetchTransactions: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Mock DB state
// ---------------------------------------------------------------------------

export interface MockTx {
  transactionId: string;
  tenantId: string;
  ownerId: string;
  provider: string;
  amountMicros: string;
  currencyCode: string;
  status: string;
  providerRef: string | null;
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey: string | null;
  metadataJson: Record<string, unknown>;
}

export interface MockDbState {
  transactions: MockTx[];
  balances: Array<{
    tenantId: string;
    currencyCode: string;
    currentBalanceMicros: string;
    updatedAt: Date | null;
  }>;
  apiKeys: Array<{
    keyId: string;
    merchantId: string;
    keyHash: string;
    keyPrefix: string;
    mode: string;
    scopes: string[];
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }>;
  ledgerEntries: Array<{
    entryId: string;
    tenantId: string;
    ownerId: string;
    entryType: string;
    amountMicros: string;
    currencyCode: string;
    provider?: string;
    sourceId?: string;
    metadataJson: Record<string, unknown>;
    createdAt: Date;
  }>;
}

export function createMockDbState(): MockDbState {
  return { transactions: [], balances: [], apiKeys: [], ledgerEntries: [] };
}

// ---------------------------------------------------------------------------
// Thenable helper — makes query chains awaitable like Drizzle
// ---------------------------------------------------------------------------

function thenable<T>(value: T): T & PromiseLike<T> {
  const obj = Object.create(null) as T & PromiseLike<T>;
  Object.assign(obj, value);
  (obj as unknown as { then: PromiseLike<T>["then"] }).then = (resolve, reject) =>
    Promise.resolve(value).then(resolve, reject);
  return obj;
}

function thenableArray<T>(arr: T[]): T[] & PromiseLike<T[]> {
  const result = [...arr] as T[] & PromiseLike<T[]>;
  (result as unknown as { then: PromiseLike<T[]>["then"] }).then = (resolve, reject) =>
    Promise.resolve(arr).then(resolve, reject);
  return result;
}

// ---------------------------------------------------------------------------
// Mock DB — Drizzle-compatible query builder
// ---------------------------------------------------------------------------

export function createMockDb(state: MockDbState): unknown {
  function createMockDbInner(s: MockDbState): unknown {
    return {
      select: (fields?: unknown) => {
        // Detect count query (fields has a 'count' key)
        const isCountQuery = fields && typeof fields === "object" && "count" in fields;

        return {
          from: (table: unknown) => {
            const whereResult = (condition: unknown) => {
              // For count queries, return count of active api keys
              if (isCountQuery) {
                const activeKeys = s.apiKeys.filter((k) => k.revokedAt === null);
                return thenableArray([{ count: activeKeys.length }]);
              }
              // Build a chainable result that supports orderBy/limit/offset/for
              const makeChainable = (data: unknown[]): unknown => {
                const chain: Record<string, unknown> = {};
                chain.limit = (n: number) => makeChainable(data);
                chain.offset = (n: number) => makeChainable(data);
                chain.orderBy = (...args: unknown[]) => makeChainable(data);
                chain.for = (mode: string) => makeChainable(data);
                // Make the chain itself thenable
                chain.then = (resolve: unknown, reject: unknown) =>
                  Promise.resolve(data).then(resolve as never, reject as never);
                return chain;
              };
              return makeChainable(s.transactions);
            };
            return { where: whereResult };
          },
        };
      },
      insert: (table: unknown) => ({
        values: (data: unknown) => {
          const record = data as Record<string, unknown>;
          const newRow = {
            keyId: crypto.randomUUID(),
            entryId: crypto.randomUUID(),
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
            ...record,
          };
          return {
            returning: () => {
              s.apiKeys.push(newRow as MockDbState["apiKeys"][0]);
              return thenableArray([newRow]);
            },
            onConflictDoUpdate: (opts: unknown) => ({
              returning: () => thenableArray([newRow]),
            }),
            onConflictDoNothing: (opts: unknown) => ({
              returning: () => {
                s.ledgerEntries.push(newRow as unknown as MockDbState["ledgerEntries"][0]);
                return thenableArray([newRow]);
              },
            }),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (data: unknown) => ({
          where: (condition: unknown) => ({
            returning: () => thenableArray([{}]),
          }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn(createMockDbInner(s));
      },
      query: {
        balanceProjections: {
          findMany: (opts?: unknown) => Promise.resolve(s.balances),
          findFirst: (opts?: unknown) => Promise.resolve(s.balances[0]),
        },
        paymentTransactions: {
          findMany: (opts?: unknown) => Promise.resolve(s.transactions),
        },
      },
    };
  }

  return createMockDbInner(state);
}

// ---------------------------------------------------------------------------
// Build test app with auth injection
// ---------------------------------------------------------------------------

export interface BuildV1TestAppOpts {
  auth?: PaykitAuthContext;
  dbState?: MockDbState;
  adapters?: PaymentProviderAdapter[];
}

export function buildV1TestApp(opts: BuildV1TestAppOpts = {}) {
  const dbState = opts.dbState ?? createMockDbState();
  const mockDb = createMockDb(dbState);
  const adapters = opts.adapters ?? [createMockAdapter("sepay")];

  // Simple registry mock
  const registry = {
    get: (id: string) => adapters.find((a) => a.id === id) ?? null,
    list: () => adapters,
    register: () => {},
  } as unknown as ProviderRegistry;

  const app = new Hono();

  // Inject auth context if provided (simulates apiKeyAuthMiddleware)
  if (opts.auth) {
    app.use("*", async (c, next) => {
      c.set("paykitAuth", opts.auth!);
      await next();
    });
  }

  const v1Router = buildV1Router({ db: mockDb as V1RouterDeps["db"], registry });
  app.route("/v1", v1Router);
  app.get("/v1/openapi.json", (c) => c.json(getOpenAPIDocument()));

  resetAllBuckets();

  return { app, dbState, registry };
}
