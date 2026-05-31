/**
 * POST /checkout/stripe — initiate USD top-up via Stripe Checkout Session.
 *
 * Body: { amountUsd: number, discountCode?: string }
 * Headers: Idempotency-Key (optional) — duplicate key returns existing pending tx.
 *
 * V1 mode: payment (one-off). Subscription is V2.
 */
import { TenantResolutionError } from "@vibecc/paykit";
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
import type { StripeClient } from "../../providers/stripe/client.js";
import { getAuthTenant } from "../../auth/auth-context.js";
import { dataJson, errorJson } from "../shared/response.js";
import { applyDiscountInTx, resolveDiscount } from "./apply-discount.js";

const stripeBodySchema = z.object({
  amountUsd: z.number().positive().min(1).max(500),
  discountCode: z.string().min(1).max(64).optional(),
});

const CURRENCY: CurrencyCode = "USD";

export interface StripeRouteDeps {
  readonly db: DbClient;
  readonly tenantResolver?: TenantResolver;
  readonly discountResolver?: DiscountResolver;
  readonly stripeClient: StripeClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildStripeCheckoutRoute(deps: StripeRouteDeps): Hono {
  const app = new Hono();
  const { db, tenantResolver, discountResolver, stripeClient, logger } = deps;

  app.post("/stripe", async (c) => {
    let parsed: z.infer<typeof stripeBodySchema>;
    try {
      const body = await c.req.json();
      parsed = stripeBodySchema.parse(body);
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
      const existing = await findByIdempotencyKey(db, idempotencyKey);
      if (existing && existing.providerRef !== null) {
        return dataJson(c, {
          transactionId: existing.transactionId,
          sessionId: existing.providerRef,
          checkoutUrl: (existing.metadataJson as { checkoutUrl?: string })?.checkoutUrl ?? "",
          discountApplied: Boolean(
            (existing.metadataJson as { discountApplied?: boolean })?.discountApplied,
          ),
        });
      }
    }

    // amountUsd in dollars; Stripe wants cents; ledger stores micros (cents × 10_000).
    const originalCents = BigInt(Math.round(parsed.amountUsd * 100));
    const originalMicros = originalCents * 10_000n;

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
        provider: "stripe",
        amountMicros: effectiveMicros.toString(),
        currencyCode: CURRENCY,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        metadataJson: {
          amountUsd: parsed.amountUsd,
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

    // Stripe wants effective amount in dollars; convert micros → USD float.
    const effectiveUsd = Number(effectiveMicros / 10_000n) / 100;
    const session = await stripeClient.createTopUpSession({
      amountUsd: effectiveUsd,
      tenantId: tenant.tenantId,
      ownerId: tenant.ownerId,
    });

    // Persist providerRef = session.id for webhook lookup; cache checkoutUrl in metadata.
    await db
      .update(paymentTransactions)
      .set({
        providerRef: session.sessionId,
        metadataJson: {
          amountUsd: parsed.amountUsd,
          originalMicros: originalMicros.toString(),
          effectiveMicros: effectiveMicros.toString(),
          discountApplied: applied,
          ...(applied && outcomeDiscount !== null
            ? {
                discountCode: (outcomeDiscount as AppliedDiscount).code,
                discountPercent: (outcomeDiscount as AppliedDiscount).percent,
              }
            : {}),
          ...(discountReason !== undefined ? { discountReason } : {}),
          checkoutUrl: session.checkoutUrl,
        },
        updatedAt: new Date(),
      })
      .where(eq(paymentTransactions.transactionId, created.transactionId));

    return dataJson(c, {
      transactionId: created.transactionId,
      sessionId: session.sessionId,
      checkoutUrl: session.checkoutUrl,
      discountApplied: applied,
      ...(outcomeDiscount !== null
        ? {
            discount: {
              code: (outcomeDiscount as AppliedDiscount).code,
              percent: (outcomeDiscount as AppliedDiscount).percent,
            },
          }
        : {}),
    });
  });

  return app;
}
