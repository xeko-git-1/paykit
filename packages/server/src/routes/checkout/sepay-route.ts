/**
 * POST /checkout/sepay — initiate VND top-up via VietQR.
 *
 * Body: { amountVnd: number, discountCode?: string }
 * Headers: Idempotency-Key (optional) — duplicate key returns existing pending tx.
 *
 * Discount flow: paykit calls discountResolver, then invokes consume(tx) inside
 * the DB transaction. Race-loser pays full price.
 */
import { TenantResolutionError, microsStringToBigInt, vndToMicros } from "@vibecc/paykit";
import type {
  AppliedDiscount,
  CurrencyCode,
  DiscountResolver,
  TenantResolver,
} from "@vibecc/paykit";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import { createTransaction, findByIdempotencyKey } from "../../db/repos/payment.repo.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import type { SePayClient } from "../../providers/sepay/client.js";
import { getAuthTenant } from "../../auth/auth-context.js";
import { dataJson, errorJson } from "../shared/response.js";
import { applyDiscountInTx, resolveDiscount } from "./apply-discount.js";

const sepayBodySchema = z.object({
  amountVnd: z.number().int().positive().min(10_000),
  discountCode: z.string().min(1).max(64).optional(),
});

export interface SepayRouteDeps {
  readonly db: DbClient;
  readonly tenantResolver?: TenantResolver;
  readonly discountResolver?: DiscountResolver;
  readonly sepayClient: SePayClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

const CURRENCY: CurrencyCode = "VND";

export function buildSepayCheckoutRoute(deps: SepayRouteDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver, discountResolver, sepayClient, logger } = deps;

  app.post("/sepay", async (c) => {
    let parsed: z.infer<typeof sepayBodySchema>;
    try {
      const body = await c.req.json();
      parsed = sepayBodySchema.parse(body);
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    let tenant: { tenantId: string; ownerId: string };

    const authTenantResult = getAuthTenant(c);
    if (authTenantResult) {
      tenant = authTenantResult;
    } else if (tenantResolver) {
      try {
        tenant = await tenantResolver(c.req.raw);
      } catch (err) {
        if (err instanceof TenantResolutionError) {
          return errorJson(c, 401, err.code, err.message);
        }
        return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
      }
    } else {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    const idempotencyKey = c.req.header("Idempotency-Key") ?? undefined;
    if (idempotencyKey !== undefined) {
      const existing = await findByIdempotencyKey(db, tenant.tenantId, idempotencyKey);
      if (existing && existing.providerRef !== null) {
        // Regenerate QR from the stored transaction amount — never trust caller-supplied
        // amount on replay, as it could differ from the original committed value.
        const storedAmountVnd = Number(microsStringToBigInt(existing.amountMicros) / 1_000_000n);
        const qr = sepayClient.generateQrUrl(existing.transactionId, storedAmountVnd);
        return dataJson(c, {
          transactionId: existing.transactionId,
          discountApplied: Boolean(
            (existing.metadataJson as { discountApplied?: boolean })?.discountApplied,
          ),
          qrUrl: qr.qrUrl,
          amount: qr.amount,
          expiresAt: qr.expiresAt.toISOString(),
        });
      }
    }

    const originalMicros = vndToMicros(parsed.amountVnd);

    // Resolve discount BEFORE transaction; consume INSIDE.
    const discountLookup = await resolveDiscount({
      ...(discountResolver !== undefined ? { resolver: discountResolver } : {}),
      req: c.req.raw,
      amountMicros: originalMicros,
      currencyCode: CURRENCY,
      ...(logger !== undefined ? { logger } : {}),
    });

    let outcomeDiscount: AppliedDiscount | null = null;
    let effectiveMicros = originalMicros;
    let applied = false;
    let discountReason: string | undefined = discountLookup.reason;

    const created = await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: discountLookup.discount,
        tx,
        amountMicros: originalMicros,
        ...(logger !== undefined ? { logger } : {}),
      });
      effectiveMicros = outcome.effectiveMicros;
      applied = outcome.applied;
      outcomeDiscount = outcome.discount;
      if (outcome.reason !== undefined) discountReason = outcome.reason;

      return createTransaction(tx, {
        tenantId: tenant.tenantId,
        ownerId: tenant.ownerId,
        provider: "sepay",
        amountMicros: effectiveMicros.toString(),
        currencyCode: CURRENCY,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        metadataJson: {
          amountVnd: parsed.amountVnd,
          originalMicros: originalMicros.toString(),
          effectiveMicros: effectiveMicros.toString(),
          discountApplied: applied,
          ...(applied && outcomeDiscount !== null
            ? {
                discountCode: (outcomeDiscount as AppliedDiscount).code,
                discountSourceId: (outcomeDiscount as AppliedDiscount).sourceId,
                discountPercent: (outcomeDiscount as AppliedDiscount).percent,
              }
            : {}),
          ...(discountReason !== undefined ? { discountReason } : {}),
        },
      });
    });

    // SePay matches webhook by orderId in transfer description (we use transactionId).
    const effectiveAmountVnd = Number(effectiveMicros / 1_000_000n);
    const qr = sepayClient.generateQrUrl(created.transactionId, effectiveAmountVnd);

    // Persist providerRef so webhook can locate this row.
    await db
      .update(paymentTransactions)
      .set({ providerRef: created.transactionId, updatedAt: new Date() })
      .where(eq(paymentTransactions.transactionId, created.transactionId));

    return dataJson(c, {
      transactionId: created.transactionId,
      discountApplied: applied,
      ...(outcomeDiscount !== null
        ? {
            discount: {
              code: (outcomeDiscount as AppliedDiscount).code,
              percent: (outcomeDiscount as AppliedDiscount).percent,
            },
          }
        : {}),
      qrUrl: qr.qrUrl,
      amount: qr.amount,
      expiresAt: qr.expiresAt.toISOString(),
    });
  });

  return app;
}
