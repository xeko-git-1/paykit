/**
 * Generic checkout router — mounts POST `/{adapterId}` for every registered adapter.
 *
 * Creating a checkout spans two systems, so the order of writes is the whole
 * design:
 *
 *   1. Validate the body and resolve the tenant.
 *   2. Convert the amount through the shared money helpers.
 *   3. In ONE transaction: consume any discount, then CLAIM the idempotency key by
 *      inserting the payment row in `provider_creating`.
 *   4. Outside any transaction: call `adapter.createCheckout()`.
 *   5. Record the provider's answer whole and move the row to `awaiting_payment`.
 *
 * The claim comes before the provider call because the row is the only durable
 * evidence that a session may exist upstream. A crash after step 4 leaves a row a
 * reconcile pass can find, instead of a live session at the provider that this
 * database cannot name — whose webhook would match nothing and whose payment would
 * never be credited.
 *
 * The claim is also insert-first rather than read-then-insert, so two concurrent
 * requests with the same key produce one checkout: the loser reads the winner's row
 * instead of failing a unique constraint, which used to be a 500 that left the key
 * permanently unusable.
 *
 * Adapters own provider-specific URL/QR construction; everything paykit-domain
 * (tenant, money, discount, idempotency) lives here.
 */
import {
  type AppliedDiscount,
  type CurrencyCode,
  type DiscountResolver,
  type PaymentProviderAdapter,
  type ProviderRegistry,
  TenantResolutionError,
  type TenantResolver,
  usdToMicros,
  vndToMicros,
} from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { claimCheckout, finalizeCheckout } from "@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js";
import type { PaymentTransaction } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { getAuthTenant } from "../../auth/auth-context.js";
import { dataJson, errorJson } from "../shared/response.js";
import { applyDiscountInTx, resolveDiscount } from "./apply-discount.js";
import { decideReplay, storableCheckoutResult } from "./checkout-replay.js";

const checkoutBodySchema = z.object({
  amountUsd: z.number().positive().min(1).max(500).multipleOf(0.01).optional(),
  amountVnd: z.number().int().positive().min(10_000).optional(),
  discountCode: z.string().min(1).max(64).optional(),
});

export interface CheckoutRouterDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly tenantResolver?: TenantResolver;
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

  // Service mode: read from auth context (fail-closed — no header fallback)
  const authTenantResult = getAuthTenant(c);
  if (authTenantResult) {
    tenant = authTenantResult;
  } else if (tenantResolver) {
    // Embedded mode: use consumer-provided resolver
    try {
      tenant = await tenantResolver(c.req.raw);
    } catch (err) {
      if (err instanceof TenantResolutionError) return errorJson(c, 401, err.code, err.message);
      return errorJson(c, 401, "TENANT_RESOLUTION_ERROR", "tenant required");
    }
  } else {
    // Service mode with no auth context — fail closed
    return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
  }

  // Currency dispatch: USD→Stripe-style, VND→SePay-style
  const currency: CurrencyCode = adapter.supportedCurrencies[0] ?? "USD";
  let amountMicros: bigint;
  if (currency === "USD") {
    if (parsed.amountUsd === undefined) {
      return errorJson(c, 400, "VALIDATION_ERROR", "amountUsd required for USD provider");
    }
    amountMicros = usdToMicros(parsed.amountUsd);
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

  // Claim the idempotency key BEFORE the provider is called. The row is the
  // durable record that a session may exist upstream: if this process dies during
  // the provider call, the row is still there in `provider_creating` and can be
  // reconciled, where previously the session was orphaned with nothing pointing at
  // it and the customer's payment could never be credited.
  //
  // A lost claim rolls the whole transaction back rather than returning normally.
  // That undoes the discount consumption above — committing it would spend the
  // customer's promo redemption on a checkout this request is not going to create.
  let claim: Awaited<ReturnType<typeof claimCheckout>>;
  try {
    claim = await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: discountLookup.discount,
        tx,
        amountMicros,
        ...(logger !== undefined ? { logger } : {}),
      });
      effectiveMicros = outcome.effectiveMicros;
      applied = outcome.applied;
      outcomeDiscount = outcome.discount;

      const result = await claimCheckout(tx, {
        tenantId: tenant.tenantId,
        ownerId: tenant.ownerId,
        provider: adapter.id,
        amountMicros: effectiveMicros.toString(),
        currencyCode: currency,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        metadataJson: checkoutMetadata({
          amountMicros,
          effectiveMicros,
          applied,
          discount: outcomeDiscount,
        }),
      });
      if (!result.created) throw new ClaimAlreadyHeld(result.row);
      return result;
    });
  } catch (err) {
    if (err instanceof ClaimAlreadyHeld) {
      return respondToExistingClaim(c, err.row);
    }
    throw err;
  }

  const created = claim.row;

  // The provider call sits outside any transaction: it is an outbound HTTP request
  // whose latency is not ours to bound, and holding a transaction across it would
  // pin a pooled connection for its duration.
  let checkoutResult: Awaited<ReturnType<PaymentProviderAdapter["createCheckout"]>>;
  try {
    checkoutResult = await adapter.createCheckout({
      transactionId: created.transactionId,
      tenantId: tenant.tenantId,
      ownerId: tenant.ownerId,
      amountMicros: effectiveMicros,
      currencyCode: currency,
    });
  } catch (err) {
    // The row stays in `provider_creating` deliberately. A failed call cannot be
    // told apart from one that created a session before failing, so the safe
    // reading is "a session may exist" — which is what that status means, and what
    // a reconcile pass looks for. Releasing the claim here would let a retry create
    // a second session for the same money.
    logger?.warn("adapter createCheckout failed — checkout left for reconcile", {
      provider: adapter.id,
      transactionId: created.transactionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson(
      c,
      502,
      "PROVIDER_CHECKOUT_FAILED",
      "Provider could not create a checkout session. Retry with the same Idempotency-Key.",
    );
  }

  // providerRef is what inbound webhooks are matched on, so it has to be stored
  // before the response goes out: a customer can pay before this request returns.
  const providerRef = checkoutResult.providerSessionId ?? created.transactionId;
  const storedResult = storableCheckoutResult({
    webUrl: checkoutResult.webUrl,
    expiresAt: checkoutResult.expiresAt,
    ...(checkoutResult.qrUrl !== undefined ? { qrUrl: checkoutResult.qrUrl } : {}),
    ...(checkoutResult.mobileDeeplink !== undefined
      ? { mobileDeeplink: checkoutResult.mobileDeeplink }
      : {}),
    discountApplied: applied,
  });

  await finalizeCheckout(db, {
    transactionId: created.transactionId,
    providerRef,
    checkoutResult: storedResult,
    metadataJson: checkoutMetadata({
      amountMicros,
      effectiveMicros,
      applied,
      discount: outcomeDiscount,
      webUrl: checkoutResult.webUrl,
    }),
  });

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

/**
 * Signals that this request lost the race for an idempotency key. Thrown so the
 * surrounding transaction rolls back — see the claim above for why that matters.
 */
class ClaimAlreadyHeld extends Error {
  constructor(readonly row: PaymentTransaction) {
    super("idempotency key already claimed");
    this.name = "ClaimAlreadyHeld";
  }
}

/** Replay the stored response, or explain why this key cannot be reused. */
function respondToExistingClaim(c: Context, row: PaymentTransaction): Response {
  const decision = decideReplay(row);
  if (decision.kind === "replay") return dataJson(c, decision.body);
  if (decision.kind === "in_progress") {
    return errorJson(
      c,
      409,
      "CHECKOUT_IN_PROGRESS",
      "A checkout for this Idempotency-Key is still being created. Retry shortly.",
    );
  }
  return errorJson(
    c,
    409,
    "CHECKOUT_NOT_REPLAYABLE",
    `The payment for this Idempotency-Key is already ${decision.status}. Use a new key.`,
  );
}

/** The bookkeeping stored on the payment row, identical on claim and finalize. */
function checkoutMetadata(opts: {
  amountMicros: bigint;
  effectiveMicros: bigint;
  applied: boolean;
  discount: AppliedDiscount | null;
  webUrl?: string;
}): Record<string, unknown> {
  const discount = opts.applied ? opts.discount : null;
  return {
    originalMicros: opts.amountMicros.toString(),
    effectiveMicros: opts.effectiveMicros.toString(),
    discountApplied: opts.applied,
    ...(discount !== null
      ? {
          discountCode: discount.code,
          discountSourceId: discount.sourceId,
          discountPercent: discount.percent,
        }
      : {}),
    ...(opts.webUrl !== undefined ? { webUrl: opts.webUrl } : {}),
  };
}
