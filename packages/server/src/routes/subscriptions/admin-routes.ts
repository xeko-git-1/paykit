/**
 * Admin subscription routes (RT F5) — cross-tenant operator surface.
 *
 *   GET  /admin/billing/subscriptions          — cross-tenant list, filters
 *   POST /admin/billing/subscriptions/:id/cancel  — Idempotency-Key required
 *   POST /admin/billing/subscriptions/:id/upgrade — Idempotency-Key required
 *
 * AdminGuard is mandatory (boot-time check lives in factory; this file
 * trusts the guard middleware to be installed). Idempotency-Key middleware
 * skipped here — admin operations carry an admin-supplied key validated by
 * the request-shape guard below; we use the operator-friendly version that
 * does NOT require tenant resolution.
 */
import type { AdminGuard, AdminGuardResult, SubscriptionAdapter } from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import * as subscriptionRepo from "@xeko-git-1/paykit-auth-core/db/repos/subscription.repo.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { adminGuardMiddleware } from "../admin/admin-guard.js";
import { dataJson, errorJson } from "../shared/response.js";
import { parseStatusFilter, toDto } from "./subscription-dto.js";

const ADMIN_KEY_MIN = 8;
const ADMIN_KEY_MAX = 128;

const cancelSchema = z.object({ atPeriodEnd: z.boolean().optional() });
const upgradeSchema = z.object({ newPriceId: z.string().min(3).max(255) });

export interface AdminSubscriptionRoutesDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
  readonly adapter: SubscriptionAdapter;
  readonly onAdminAction?: (action: {
    action: string;
    adminUserId: string | undefined;
    role: string | undefined;
    payload: Record<string, unknown>;
  }) => void | Promise<void>;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildAdminSubscriptionRoutes(deps: AdminSubscriptionRoutesDeps): Hono {
  const app = new Hono();
  const { db, adminGuard, adapter, onAdminAction, logger } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.get("/", async (c) => {
    const tenantId = c.req.query("tenantId");
    if (tenantId !== undefined && !/^[0-9a-f-]{36}$/i.test(tenantId)) {
      return errorJson(c, 400, "INVALID_TENANT_ID", "tenantId must be a UUID");
    }
    const statuses = parseStatusFilter(c.req.query("status"));
    if (statuses && statuses.length === 0) {
      return errorJson(c, 400, "INVALID_STATUS", "status filter contains no valid values");
    }
    const rows = tenantId
      ? await subscriptionRepo.listForTenant(db, tenantId, {
          ...(statuses ? { statuses } : {}),
          limit: 200,
        })
      : await listAllProvider(db, adapter.id, statuses);
    return dataJson(c, { subscriptions: rows.map(toDto) });
  });

  app.post("/:id/cancel", async (c) => {
    const guard = guardKey(c);
    if ("error" in guard) return guard.error;
    const cached = await subscriptionRepo.findById(db, c.req.param("id"));
    if (!cached) return errorJson(c, 404, "NOT_FOUND", "subscription not found");

    const parsed = await parseBody(c, cancelSchema);
    if ("error" in parsed) return errorJson(c, 400, "VALIDATION_ERROR", parsed.error);

    const result = await adapter.cancel({
      subscriptionId: cached.providerSubscriptionId,
      atPeriodEnd: parsed.data.atPeriodEnd ?? true,
      idempotencyKey: guard.key,
    });
    await subscriptionRepo.upsertFromEvent(db, {
      tenantId: cached.tenantId,
      ownerId: cached.ownerId,
      provider: cached.provider,
      providerSubscriptionId: result.id,
      customerId: result.customerId,
      priceId: result.priceId,
      status: result.status,
      currencyCode: result.currencyCode,
      currentPeriodEnd: result.currentPeriodEnd,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      lastEventCreated: result.lastEventCreated,
      ...(result.latestInvoiceId !== undefined ? { latestInvoiceId: result.latestInvoiceId } : {}),
    });
    void emitAudit(onAdminAction, c, "admin_cancel_subscription", {
      subscriptionId: cached.subscriptionId,
      tenantId: cached.tenantId,
      atPeriodEnd: parsed.data.atPeriodEnd ?? true,
    });
    const refreshed = await subscriptionRepo.findById(db, cached.subscriptionId);
    return dataJson(c, toDto(refreshed ?? cached));
  });

  app.post("/:id/upgrade", async (c) => {
    const guard = guardKey(c);
    if ("error" in guard) return guard.error;
    const cached = await subscriptionRepo.findById(db, c.req.param("id"));
    if (!cached) return errorJson(c, 404, "NOT_FOUND", "subscription not found");

    const parsed = await parseBody(c, upgradeSchema);
    if ("error" in parsed) return errorJson(c, 400, "VALIDATION_ERROR", parsed.error);

    const result = await adapter.upgrade({
      subscriptionId: cached.providerSubscriptionId,
      newPriceId: parsed.data.newPriceId,
      idempotencyKey: guard.key,
    });
    await subscriptionRepo.upsertFromEvent(db, {
      tenantId: cached.tenantId,
      ownerId: cached.ownerId,
      provider: cached.provider,
      providerSubscriptionId: result.id,
      customerId: result.customerId,
      priceId: result.priceId,
      status: result.status,
      currencyCode: result.currencyCode,
      currentPeriodEnd: result.currentPeriodEnd,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      lastEventCreated: result.lastEventCreated,
      ...(result.latestInvoiceId !== undefined ? { latestInvoiceId: result.latestInvoiceId } : {}),
    });
    void emitAudit(onAdminAction, c, "admin_upgrade_subscription", {
      subscriptionId: cached.subscriptionId,
      tenantId: cached.tenantId,
      newPriceId: parsed.data.newPriceId,
    });
    const refreshed = await subscriptionRepo.findById(db, cached.subscriptionId);
    return dataJson(c, toDto(refreshed ?? cached));
  });

  void logger;
  return app;
}

function guardKey(c: Context): { key: string } | { error: Response } {
  const key = c.req.header("Idempotency-Key") ?? "";
  if (key.length < ADMIN_KEY_MIN || key.length > ADMIN_KEY_MAX) {
    return {
      error: errorJson(
        c,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        `Idempotency-Key header required (${ADMIN_KEY_MIN}-${ADMIN_KEY_MAX} chars)`,
      ),
    };
  }
  return { key };
}

async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ data: z.infer<S> } | { error: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };
  return { data: parsed.data };
}

async function emitAudit(
  cb: AdminSubscriptionRoutesDeps["onAdminAction"],
  c: Context,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!cb) return;
  const ctx = c.get("adminContext") as AdminGuardResult | undefined;
  try {
    await cb({
      action,
      adminUserId: ctx?.adminUserId,
      role: ctx?.role,
      payload,
    });
  } catch {
    /* fire-and-forget */
  }
}

async function listAllProvider(
  db: DbClient,
  providerId: string,
  statuses: readonly string[] | null,
) {
  const { subscriptions } = await import("@xeko-git-1/paykit-auth-core/db/schema/subscriptions.js");
  const { and, desc, eq, inArray } = await import("drizzle-orm");
  const conds = [eq(subscriptions.provider, providerId)];
  if (statuses && statuses.length > 0) conds.push(inArray(subscriptions.status, [...statuses]));
  return db
    .select()
    .from(subscriptions)
    .where(and(...conds))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(500);
}
