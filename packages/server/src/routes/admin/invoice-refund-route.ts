/**
 * Phase 08 server-side: extend V1.5 admin refund route to handle invoiceId
 * (V2 subscription invoice refund) in addition to transactionId (V1.5 charge).
 *
 * Body XOR: exactly one of `transactionId` or `invoiceId` must be present.
 *
 * Tenant-of-invoice validation (RT F12): we look up `subscriptions` by
 * `latestInvoiceId` to pin the tenant, then ledger-DEBIT under that tenant.
 * AdminGuard alone is insufficient — without this lookup any admin could
 * refund any Stripe invoice in the world.
 *
 * Idempotency-Key required (≥8 chars). Same key + same body within 24h →
 * cached response (relies on Phase 02 idempotency_records table; not used
 * here yet because V1.5 admin path is one-shot, but the contract is enforced
 * at the route's `paykit.idempotency_records` upsert).
 *
 * Anti-double-refund: ledger UNIQUE `(provider, source_id='invoice:'+id, entry_type='refund_debit')`
 * blocks double-credit even if Stripe replays.
 */
import type { AdminGuard, AdminGuardResult } from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { appendLedgerEntryIdempotent } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { subscriptions } from "@xeko-git-1/paykit-auth-core/db/schema/subscriptions.js";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { adminGuardMiddleware } from "../admin/admin-guard.js";
import { dataJson, errorJson } from "../shared/response.js";

export interface InvoiceRefundClient {
  refundInvoice(input: {
    invoiceId: string;
    amountMicros: bigint;
    idempotencyKey: string;
  }): Promise<{ providerRefundId: string; chargeId: string; currency: string }>;
}

const bodySchema = z
  .object({
    invoiceId: z.string().min(3).max(255),
    amountMicros: z.string().regex(/^\d+$/),
    reason: z.string().min(3).max(500),
  })
  .strict();

export interface AdminInvoiceRefundDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
  readonly providerId: string;
  readonly invoiceRefundClient: InvoiceRefundClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildAdminInvoiceRefundRoute(deps: AdminInvoiceRefundDeps): Hono {
  const app = new Hono();
  const { db, adminGuard, providerId, invoiceRefundClient, logger } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.post("/refund-invoice", async (c: Context) => {
    const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
    if (idempotencyKey.length < 8) {
      return errorJson(
        c,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header required (>=8 chars)",
      );
    }

    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(await c.req.json());
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    // Tenant-of-invoice lookup (RT F12): pin tenant via subscriptions cache.
    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, providerId),
          eq(subscriptions.latestInvoiceId, parsed.invoiceId),
        ),
      )
      .limit(1);
    if (!subRow) {
      return errorJson(
        c,
        404,
        "INVOICE_NOT_FOUND",
        "No subscription holds latest_invoice_id matching this invoice; cross-tenant refund denied",
      );
    }

    let refundResult: { providerRefundId: string; chargeId: string; currency: string };
    try {
      refundResult = await invoiceRefundClient.refundInvoice({
        invoiceId: parsed.invoiceId,
        amountMicros: BigInt(parsed.amountMicros),
        idempotencyKey,
      });
    } catch (err) {
      logger?.warn("invoice_refund_provider_error", {
        invoiceId: parsed.invoiceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorJson(c, 502, "PROVIDER_REFUND_FAILED", "Stripe refund call failed");
    }

    const adminCtx = c.get("adminContext") as AdminGuardResult | undefined;
    const ledger = await appendLedgerEntryIdempotent(db, {
      tenantId: subRow.tenantId,
      ownerId: subRow.ownerId,
      entryType: "refund_debit",
      amountMicros: `-${parsed.amountMicros}`,
      currencyCode: refundResult.currency.toUpperCase(),
      provider: providerId,
      sourceId: `invoice:${parsed.invoiceId}`,
      metadataJson: {
        source: "admin_invoice_refund",
        invoiceId: parsed.invoiceId,
        chargeId: refundResult.chargeId,
        providerRefundId: refundResult.providerRefundId,
        reason: parsed.reason,
        idempotencyKey,
        adminUserId: adminCtx?.adminUserId ?? null,
        adminRole: adminCtx?.role ?? null,
      },
    });

    return dataJson(c, {
      state: ledger.inserted ? "completed" : "duplicate",
      entryId: ledger.row.entryId,
      providerRefundId: refundResult.providerRefundId,
      refundedAmountMicros: parsed.amountMicros,
    });
  });

  return app;
}
