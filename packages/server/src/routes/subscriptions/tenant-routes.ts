/**
 * Tenant-scoped subscription routes (RT F8 outbox + RT F11 status filter).
 *
 *   POST   /billing/subscriptions          — subscribe (Idempotency-Key required)
 *   GET    /billing/subscriptions          — list, filter ?status=
 *   GET    /billing/subscriptions/:id      — single (404 if not own)
 *   POST   /billing/subscriptions/:id/cancel  — Idempotency-Key required
 *   POST   /billing/subscriptions/:id/upgrade — Idempotency-Key required
 *
 * Subscribe outbox flow (RT F8):
 *   1. resolve tenant + customer
 *   2. call adapter.subscribe (Stripe is source of truth)
 *   3. UPSERT cache via subscription.repo.upsertFromEvent
 * If step 3 fails after step 2 succeeds, the same Idempotency-Key on retry
 * reaches Stripe with the same key — Stripe returns the same sub. Reconciler
 * Pass A picks up the cache gap within minutes.
 */
import type { CustomerProviderPort } from "../../services/customer-service.js";
import type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  SubscriptionAdapter,
  SubscriptionResult,
  TenantResolver,
  UpgradeSubscriptionInput,
} from "@vibecc/paykit";
import { TenantResolutionError } from "@vibecc/paykit";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import * as subscriptionRepo from "../../db/repos/subscription.repo.js";
import { buildCustomerService } from "../../services/customer-service.js";
import { dataJson, errorJson } from "../shared/response.js";
import {
  buildIdempotencyMiddleware,
  readBodyJson,
} from "./idempotency-middleware.js";
import { parseStatusFilter, toDto } from "./subscription-dto.js";

const subscribeSchema = z.object({
  priceId: z.string().min(3).max(255),
  trialDays: z.number().int().min(0).max(365).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const cancelSchema = z.object({ atPeriodEnd: z.boolean().optional() });

const upgradeSchema = z.object({ newPriceId: z.string().min(3).max(255) });

export interface TenantSubscriptionRoutesDeps {
  readonly db: DbClient;
  readonly tenantResolver: TenantResolver;
  readonly adapter: SubscriptionAdapter;
  readonly customerProvider: CustomerProviderPort;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildTenantSubscriptionRoutes(deps: TenantSubscriptionRoutesDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver, adapter, customerProvider, logger } = deps;
  const customerSvc = buildCustomerService({ db, provider: customerProvider });

  const idem = buildIdempotencyMiddleware({ db, tenantResolver, provider: adapter.id });

  // ---- LIST + GET (no Idempotency-Key) ----
  app.get("/", async (c) => {
    const tenant = await resolveTenant(c, tenantResolver);
    if ("error" in tenant) return tenant.error;
    const statuses = parseStatusFilter(c.req.query("status"));
    if (statuses && statuses.length === 0) {
      return errorJson(c, 400, "INVALID_STATUS", "status filter contains no valid values");
    }
    const rows = await subscriptionRepo.listForTenant(db, tenant.tenantId, {
      ...(statuses ? { statuses } : {}),
      limit: 200,
    });
    return dataJson(c, { subscriptions: rows.map(toDto) });
  });

  app.get("/:id", async (c) => {
    const tenant = await resolveTenant(c, tenantResolver);
    if ("error" in tenant) return tenant.error;
    const row = await subscriptionRepo.findById(db, c.req.param("id"));
    if (!row || row.tenantId !== tenant.tenantId) {
      return errorJson(c, 404, "NOT_FOUND", "subscription not found");
    }
    return dataJson(c, toDto(row));
  });

  // ---- WRITE PATHS — gated by Idempotency-Key ----
  app.use("/", idem);
  app.use("/:id/*", idem);

  app.post("/", async (c) => {
    const tenant = await resolveTenant(c, tenantResolver);
    if ("error" in tenant) return tenant.error;

    const parsed = parseBody(c.get("paykitIdempotencyBodyText"), subscribeSchema);
    if ("error" in parsed) return errorJson(c, 400, "VALIDATION_ERROR", parsed.error);
    const idempotencyKey = c.get("paykitIdempotencyKey");

    const customerId = await customerSvc.getOrCreateCustomer({ tenantId: tenant.tenantId });
    const stripeInput: CreateSubscriptionInput = {
      customerId,
      priceId: parsed.data.priceId,
      paykitTenantId: tenant.tenantId,
      idempotencyKey,
      ...(parsed.data.trialDays !== undefined ? { trialDays: parsed.data.trialDays } : {}),
      ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
    };
    const sub = await adapter.subscribe(stripeInput);
    await persistSub(deps, tenant, sub);
    const row = await subscriptionRepo.findByProviderSub(db, adapter.id, sub.id);
    if (!row) return errorJson(c, 500, "SUBSCRIBE_PERSIST_FAILED", "subscription cache write failed");
    return dataJson(c, toDto(row), 201);
  });

  app.post("/:id/cancel", async (c) => {
    const tenant = await resolveTenant(c, tenantResolver);
    if ("error" in tenant) return tenant.error;
    const cached = await subscriptionRepo.findById(db, c.req.param("id"));
    if (!cached || cached.tenantId !== tenant.tenantId) {
      return errorJson(c, 404, "NOT_FOUND", "subscription not found");
    }
    const parsed = parseBody(c.get("paykitIdempotencyBodyText"), cancelSchema);
    if ("error" in parsed) return errorJson(c, 400, "VALIDATION_ERROR", parsed.error);
    const cancelInput: CancelSubscriptionInput = {
      subscriptionId: cached.providerSubscriptionId,
      atPeriodEnd: parsed.data.atPeriodEnd ?? true,
      idempotencyKey: c.get("paykitIdempotencyKey"),
    };
    const result = await adapter.cancel(cancelInput);
    await persistSub(deps, tenant, result);
    const row = await subscriptionRepo.findById(db, cached.subscriptionId);
    return dataJson(c, toDto(row ?? cached));
  });

  app.post("/:id/upgrade", async (c) => {
    const tenant = await resolveTenant(c, tenantResolver);
    if ("error" in tenant) return tenant.error;
    const cached = await subscriptionRepo.findById(db, c.req.param("id"));
    if (!cached || cached.tenantId !== tenant.tenantId) {
      return errorJson(c, 404, "NOT_FOUND", "subscription not found");
    }
    const parsed = parseBody(c.get("paykitIdempotencyBodyText"), upgradeSchema);
    if ("error" in parsed) return errorJson(c, 400, "VALIDATION_ERROR", parsed.error);
    const upgradeInput: UpgradeSubscriptionInput = {
      subscriptionId: cached.providerSubscriptionId,
      newPriceId: parsed.data.newPriceId,
      idempotencyKey: c.get("paykitIdempotencyKey"),
    };
    const result = await adapter.upgrade(upgradeInput);
    await persistSub(deps, tenant, result);
    const row = await subscriptionRepo.findById(db, cached.subscriptionId);
    return dataJson(c, toDto(row ?? cached));
  });

  void logger;
  void readBodyJson;
  return app;
}

async function resolveTenant(
  c: { req: { raw: Request } },
  tenantResolver: TenantResolver,
): Promise<{ tenantId: string; ownerId: string } | { error: Response }> {
  try {
    return await tenantResolver(c.req.raw);
  } catch (err) {
    const code = err instanceof TenantResolutionError ? err.code : "TENANT_RESOLUTION_ERROR";
    const message = err instanceof Error ? err.message : "tenant required";
    return {
      error: new Response(JSON.stringify({ error: { code, message } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    };
  }
}

function parseBody<S extends z.ZodTypeAny>(
  text: string,
  schema: S,
): { data: z.infer<S> } | { error: string } {
  let raw: unknown;
  try {
    raw = text === "" ? {} : JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "invalid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };
  return { data: parsed.data };
}

async function persistSub(
  deps: TenantSubscriptionRoutesDeps,
  tenant: { tenantId: string; ownerId: string },
  sub: SubscriptionResult,
): Promise<void> {
  await subscriptionRepo.upsertFromEvent(deps.db, {
    tenantId: tenant.tenantId,
    ownerId: tenant.ownerId,
    provider: deps.adapter.id,
    providerSubscriptionId: sub.id,
    customerId: sub.customerId,
    priceId: sub.priceId,
    status: sub.status,
    currencyCode: sub.currencyCode,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    lastEventCreated: sub.lastEventCreated,
    ...(sub.latestInvoiceId !== undefined ? { latestInvoiceId: sub.latestInvoiceId } : {}),
  });
}
