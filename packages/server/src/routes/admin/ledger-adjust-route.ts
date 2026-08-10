/**
 * POST /admin/ledger/adjust — manual credit/debit by admin operator.
 *
 * Body: { tenantId, ownerId, amountMicros, currencyCode, entryType, reason }
 * - entryType ∈ {credit, debit, manual_adjustment}
 * - reason min 3 chars (audit-required)
 *
 * Atomic: ledger insert + balance applyDelta in single DB transaction.
 * Emits via `onAdminAction` (fire-and-forget, errors swallowed).
 */
import type { AdminGuard, AdminGuardResult } from "@xeko-git-1/paykit";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { applyDelta } from "@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js";
import { appendLedgerEntry } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { dataJson, errorJson } from "../shared/response.js";
import { adminGuardMiddleware } from "./admin-guard.js";

const adjustBodySchema = z.object({
  tenantId: z.string().uuid(),
  ownerId: z.string().uuid(),
  amountMicros: z.string().regex(/^-?\d+$/),
  currencyCode: z.enum(["USD", "VND"]),
  entryType: z.enum(["credit", "debit", "manual_adjustment"]),
  reason: z.string().min(3).max(500),
});

export interface AdminAuditAction {
  readonly action: string;
  readonly adminUserId: string | undefined;
  readonly role: string | undefined;
  readonly payload: Record<string, unknown>;
}

export interface AdminLedgerAdjustDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
  readonly onAdminAction?: (action: AdminAuditAction) => void | Promise<void>;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildAdminLedgerAdjustRoute(deps: AdminLedgerAdjustDeps): Hono {
  const app = new Hono();
  const { db, adminGuard, onAdminAction, logger } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.post("/ledger/adjust", async (c) => {
    let body: z.infer<typeof adjustBodySchema>;
    try {
      const parsed = await c.req.json();
      body = adjustBodySchema.parse(parsed);
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    const adminCtx = c.get("adminContext") as AdminGuardResult;
    const deltaMicros = BigInt(body.amountMicros);

    const entry = await db.transaction(async (tx) => {
      const ledgerRow = await appendLedgerEntry(tx, {
        tenantId: body.tenantId,
        ownerId: body.ownerId,
        entryType: body.entryType,
        amountMicros: body.amountMicros,
        currencyCode: body.currencyCode,
        metadataJson: {
          source: "admin_adjustment",
          reason: body.reason,
          adminActorId: adminCtx.adminUserId ?? null,
          adminRole: adminCtx.role ?? null,
        },
      });
      await applyDelta(tx, body.tenantId, body.currencyCode, deltaMicros);
      return ledgerRow;
    });

    // Fire-and-forget audit hook — does not roll back DB on throw.
    if (onAdminAction) {
      try {
        await onAdminAction({
          action: "ledger.adjust",
          adminUserId: adminCtx.adminUserId,
          role: adminCtx.role,
          payload: {
            entryId: entry.entryId,
            tenantId: body.tenantId,
            currencyCode: body.currencyCode,
            entryType: body.entryType,
            amountMicros: body.amountMicros,
            reason: body.reason,
          },
        });
      } catch (err) {
        logger?.warn("onAdminAction threw — swallowed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return dataJson(c, {
      entryId: entry.entryId,
      entryType: entry.entryType,
      amountMicros: entry.amountMicros,
      currencyCode: entry.currencyCode,
      createdAt: entry.createdAt.toISOString(),
    });
  });

  return app;
}
