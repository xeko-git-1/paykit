/**
 * Generic checkout router — V1.5.
 *
 * Mounts POST `/{adapterId}` for every adapter in registry. Server-level
 * pipeline:
 *   1. Validate body shape (adapter-specific via Zod schema dispatch)
 *   2. Resolve tenant via TenantResolver
 *   3. Optional Idempotency-Key lookup → return existing pending tx
 *   4. Resolve discount via discountResolver hook
 *   5. Inside db.transaction:
 *        a. Apply discount.consume() if present (race-safe)
 *        b. createTransaction with effective amount
 *   6. Call adapter.createCheckout() → response
 *   7. Persist provider_ref + checkout metadata
 *
 * Adapter handles provider-specific URL/QR construction. Server handles all
 * paykit-domain logic (DB, tenant, discount, idempotency).
 */
import {
  type AppliedDiscount,
  type CurrencyCode,
  type DiscountResolver,
  type PaymentProviderAdapter,
  type ProviderRegistry,
  TenantResolutionError,
  type TenantResolver,
  vndToMicros,
} from "@vibecc/paykit";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "../../db/client.js";
import { createTransaction, findByIdempotencyKey } from "../../db/repos/payment.repo.js";
import { paymentTransactions } from "../../db/schema/payment-transactions.js";
import { dataJson, errorJson } from "../shared/response.js";
import { applyDiscountInTx, resolveDiscount } from "./apply-discount.js";

const checkoutBodySchema = z.object({
  amountUsd: z.number().positive().min(1).max(500).optional(),
  amountVnd: z.number().int().positive().min(10_000).optional(),
  discountCode: z.string().min(1).max(64).optional(),
});

export interface CheckoutRouterDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly tenantResolver: TenantResolver;
  readonly discountResolver?: DiscountResolver;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

export function buildCheckoutRouter(deps: CheckoutRouterDeps): Hono {
  const app = new Hono();

  for (const adapter of deps.registry.list()) {
    app.post(`/${adapter.id}`, async (c) => handleCheckout(c, adapter, deps));
  }

  return app;
}

async function handleCheckout(
  c: Context,
  adapter: PaymentProviderAdapter,
  deps: CheckoutRouterDeps,
): Promise<Response> {
  const { db, tenantResolver, discountResolver, logger } = deps;

  let parsed: z.infer<typeof checkoutBodySchema>;
  try {
    const body = await c.req.json();
    parsed = checkoutBodySchema.parse(body);
  } catch (err) {
    return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
  }

  let tenant: { tenantId: string; ownerId: string };
  try {
    tenant = await tenantResolver(c.req.raw);
  } catch (err) {
    if (err instanceof TenantResolutionError) return errorJson(c, 401, err.code, err.message);
    return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
  }

  // Currency dispatch: USD→Stripe-style, VND→SePay-style
  const currency: CurrencyCode = adapter.supportedCurrencies[0] ?? "USD";
  let amountMicros: bigint;
  if (currency === "USD") {
    if (parsed.amountUsd === undefined) {
      return errorJson(c, 400, "VALIDATION_ERROR", "amountUsd required for USD provider");
    }
    amountMicros = BigInt(Math.round(parsed.amountUsd * 100)) * 10_000n;
  } else if (currency === "VND") {
    if (parsed.amountVnd === undefined) {
      return errorJson(c, 400, "VALIDATION_ERROR", "amountVnd required for VND provider");
    }
    amountMicros = vndToMicros(parsed.amountVnd);
  } else {
    return errorJson(
      c,
      400,
      "UNSUPPORTED_CURRENCY",
      `Provider supports: ${adapter.supportedCurrencies.join(", ")}`,
    );
  }

  const idempotencyKey = c.req.header("Idempotency-Key") ?? undefined;
  if (idempotencyKey !== undefined) {
    const existing = await findByIdempotencyKey(db, idempotencyKey);
    if (existing && existing.providerRef !== null) {
      return dataJson(c, {
        transactionId: existing.transactionId,
        provider: existing.provider,
        providerRef: existing.providerRef,
        cached: true,
      });
    }
  }

  const discountLookup = await resolveDiscount({
    ...(discountResolver !== undefined ? { resolver: discountResolver } : {}),
    req: c.req.raw,
    amountMicros,
    currencyCode: currency,
    ...(logger !== undefined ? { logger } : {}),
  });

  let outcomeDiscount: AppliedDiscount | null = null;
  let effectiveMicros = amountMicros;
  let applied = false;

  const created = await db.transaction(async (tx) => {
    const outcome = await applyDiscountInTx({
      discount: discountLookup.discount,
      tx,
      amountMicros,
      ...(logger !== undefined ? { logger } : {}),
    });
    effectiveMicros = outcome.effectiveMicros;
    applied = outcome.applied;
    outcomeDiscount = outcome.discount;

    return createTransaction(tx, {
      tenantId: tenant.tenantId,
      ownerId: tenant.ownerId,
      provider: adapter.id,
      amountMicros: effectiveMicros.toString(),
      currencyCode: currency,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      metadataJson: {
        originalMicros: amountMicros.toString(),
        effectiveMicros: effectiveMicros.toString(),
        discountApplied: applied,
        ...(applied && outcomeDiscount !== null
          ? {
              discountCode: (outcomeDiscount as AppliedDiscount).code,
              discountSourceId: (outcomeDiscount as AppliedDiscount).sourceId,
              discountPercent: (outcomeDiscount as AppliedDiscount).percent,
            }
          : {}),
      },
    });
  });

  // Adapter creates provider-side checkout
  const checkoutResult = await adapter.createCheckout({
    transactionId: created.transactionId,
    tenantId: tenant.tenantId,
    ownerId: tenant.ownerId,
    amountMicros: effectiveMicros,
    currencyCode: currency,
  });

  // Persist providerRef = whatever adapter returned (session id, transactionId for SePay, etc.)
  const providerRef = checkoutResult.providerSessionId ?? created.transactionId;
  await db
    .update(paymentTransactions)
    .set({
      providerRef,
      metadataJson: {
        originalMicros: amountMicros.toString(),
        effectiveMicros: effectiveMicros.toString(),
        discountApplied: applied,
        ...(applied && outcomeDiscount !== null
          ? {
              discountCode: (outcomeDiscount as AppliedDiscount).code,
              discountPercent: (outcomeDiscount as AppliedDiscount).percent,
            }
          : {}),
        webUrl: checkoutResult.webUrl,
      },
      updatedAt: new Date(),
    })
    .where(eq(paymentTransactions.transactionId, created.transactionId));

  return dataJson(c, {
    transactionId: created.transactionId,
    provider: adapter.id,
    webUrl: checkoutResult.webUrl,
    ...(checkoutResult.qrUrl !== undefined ? { qrUrl: checkoutResult.qrUrl } : {}),
    ...(checkoutResult.mobileDeeplink !== undefined
      ? { mobileDeeplink: checkoutResult.mobileDeeplink }
      : {}),
    expiresAt: checkoutResult.expiresAt.toISOString(),
    discountApplied: applied,
  });
}
