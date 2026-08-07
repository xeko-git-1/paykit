/**
 * /v1 API router — wires endpoints with scope, plane, and rate-limit guards.
 *
 * Endpoints:
 *   POST /v1/checkouts   [api_key, checkout:write]
 *   GET  /v1/balances    [api_key, balance:read]
 *   GET  /v1/payments    [api_key, payments:read]
 *   POST /v1/refunds     [api_key, refund:write] + ownership check
 *   POST /v1/api-keys    [jwt plane ONLY, key:manage] + scope-subset + DB cap
 */
import type { AppliedDiscount, ProviderRegistry } from "@vibecc/paykit";
import { usdToMicros, vndToMicros } from "@vibecc/paykit";
import {
  type DbClient,
  type PaykitAuthContext,
  MAX_ACTIVE_KEYS_PER_MERCHANT,
  SCOPES,
  apiKeyRepo,
  applyDiscountInTx,
  balanceRepo,
  dataJson,
  discountRepo,
  errorJson,
  executeRefund,
  isScopeSubset,
  mintApiKey,
  paymentRepo,
  paymentTransactions,
  requirePlane,
  requireScope,
} from "@vibecc/paykit-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import {
  API_VERSION,
  CreateCheckoutBody,
  CreateRefundBody,
  MintApiKeyBody,
  PaymentsQueryParams,
} from "./dto.js";
import { rateLimitMiddleware } from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface V1RouterDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void } | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildV1Router(deps: V1RouterDeps): Hono {
  const { db, registry, logger } = deps;
  const app = new Hono();

  // Rate-limit applies to all /v1 routes (soft, per-process)
  app.use("*", rateLimitMiddleware());

  // -------------------------------------------------------------------------
  // POST /checkouts — create a payment checkout session
  // -------------------------------------------------------------------------
  app.post("/checkouts", requireScope(SCOPES.CHECKOUT_WRITE), async (c) => {
    const auth = c.get("paykitAuth") as PaykitAuthContext;

    let parsed: z.infer<typeof CreateCheckoutBody>;
    try {
      const body = await c.req.json();
      parsed = CreateCheckoutBody.parse(body);
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    const adapter = registry.get(parsed.provider);
    if (!adapter) {
      return errorJson(c, 400, "INVALID_PROVIDER", `unknown provider: ${parsed.provider}`);
    }

    // Delegate to existing checkout logic (simplified — version+scope wrap only)
    const currency = adapter.supportedCurrencies[0] ?? "USD";
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
      // Was `BigInt(parsed.amountVnd) * 1_000_000n`, which skipped the integer
      // check `vndToMicros` performs: a fractional dong reached BigInt() and threw
      // a RangeError, surfacing as a 500 instead of a validation error.
      amountMicros = vndToMicros(parsed.amountVnd);
    } else {
      return errorJson(c, 400, "UNSUPPORTED_CURRENCY", `unsupported: ${currency}`);
    }

    // Resolve a promo code (if supplied) to a race-safe AppliedDiscount whose
    // consume() RESERVES one unit inside the checkout transaction. The cap
    // counts completed payments, so reserve only holds the slot; the payment
    // webhook later commits it (on payment.completed) or releases it (on
    // failure/expiry). reserve only succeeds while the code is active,
    // unexpired, and reserved + times_redeemed is under the cap.
    let appliedDiscount: AppliedDiscount | null = null;
    let discountId: string | null = null;
    if (parsed.discountCode !== undefined) {
      const row = await discountRepo.findActiveByCode(
        db,
        auth.tenant.tenantId,
        parsed.discountCode,
      );
      if (row) {
        discountId = row.discountId;
        appliedDiscount = {
          percent: Number(row.percent),
          code: row.code,
          sourceId: row.discountId,
          // tx is the opaque DbTransaction handle the consumer contract passes
          // through; the repo accepts the same Drizzle tx as a DbOrTx.
          consume: (tx) => discountRepo.reserve(tx as DbClient, row.discountId),
        };
      }
    }

    // Apply the discount and persist the transaction in one DB transaction so a
    // lost reservation race falls back to full price atomically. The discountId
    // is stamped on the tx metadata so the payment webhook can commit or
    // release the reservation later.
    let effectiveMicros = amountMicros;
    let discountApplied = false;
    const created = await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: appliedDiscount,
        tx,
        amountMicros,
        ...(logger !== undefined ? { logger } : {}),
      });
      effectiveMicros = outcome.effectiveMicros;
      discountApplied = outcome.applied;
      return paymentRepo.createTransaction(tx, {
        tenantId: auth.tenant.tenantId,
        ownerId: auth.tenant.ownerId,
        provider: adapter.id,
        amountMicros: effectiveMicros.toString(),
        currencyCode: currency,
        ...(discountApplied && discountId !== null
          ? { metadataJson: { discountId, discountApplied: true } }
          : {}),
      });
    });

    // createCheckout runs after the commit. If the provider call fails the
    // reservation would otherwise be stranded (the payment can never complete),
    // so release it before surfacing the error.
    let checkoutResult: Awaited<ReturnType<typeof adapter.createCheckout>>;
    try {
      checkoutResult = await adapter.createCheckout({
        transactionId: created.transactionId,
        tenantId: auth.tenant.tenantId,
        ownerId: auth.tenant.ownerId,
        amountMicros: effectiveMicros,
        currencyCode: currency,
      });
    } catch (err) {
      if (discountApplied && discountId !== null) {
        await discountRepo.releaseReservation(db, discountId).catch(() => {});
      }
      throw err;
    }

    const providerRef = checkoutResult.providerSessionId ?? created.transactionId;
    await db
      .update(paymentTransactions)
      .set({ providerRef, updatedAt: new Date() })
      .where(eq(paymentTransactions.transactionId, created.transactionId));

    return c.json({
      apiVersion: API_VERSION,
      data: {
        transactionId: created.transactionId,
        provider: adapter.id,
        webUrl: checkoutResult.webUrl,
        ...(checkoutResult.qrUrl ? { qrUrl: checkoutResult.qrUrl } : {}),
        ...(checkoutResult.mobileDeeplink ? { mobileDeeplink: checkoutResult.mobileDeeplink } : {}),
        expiresAt: checkoutResult.expiresAt.toISOString(),
        discountApplied,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /balances — list all currency balances for the authenticated merchant
  // -------------------------------------------------------------------------
  app.get("/balances", requireScope(SCOPES.BALANCE_READ), async (c) => {
    const auth = c.get("paykitAuth") as PaykitAuthContext;
    const balances = await balanceRepo.listBalancesByTenant(db, auth.tenant.tenantId);

    return c.json({
      apiVersion: API_VERSION,
      data: balances.map((b) => ({
        currencyCode: b.currencyCode,
        currentBalanceMicros: b.currentBalanceMicros,
        updatedAt: b.updatedAt?.toISOString() ?? null,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // GET /payments — list payment transactions for the authenticated merchant
  // -------------------------------------------------------------------------
  app.get("/payments", requireScope(SCOPES.PAYMENTS_READ), async (c) => {
    const auth = c.get("paykitAuth") as PaykitAuthContext;

    let query: z.infer<typeof PaymentsQueryParams>;
    try {
      query = PaymentsQueryParams.parse({
        limit: c.req.query("limit"),
        offset: c.req.query("offset"),
      });
    } catch {
      query = { limit: 50, offset: 0 };
    }

    const payments = await paymentRepo.listByTenant(db, auth.tenant.tenantId, {
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({
      apiVersion: API_VERSION,
      data: payments.map((p) => ({
        transactionId: p.transactionId,
        provider: p.provider,
        amountMicros: p.amountMicros,
        currencyCode: p.currencyCode,
        status: p.status,
        providerRef: p.providerRef,
        createdAt: p.createdAt.toISOString(),
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /refunds — merchant-initiated refund with ownership enforcement
  // -------------------------------------------------------------------------
  app.post("/refunds", requireScope(SCOPES.REFUND_WRITE), async (c) => {
    const auth = c.get("paykitAuth") as PaykitAuthContext;

    let parsed: z.infer<typeof CreateRefundBody>;
    try {
      const body = await c.req.json();
      parsed = CreateRefundBody.parse(body);
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
    if (idempotencyKey === "" || idempotencyKey.length < 8) {
      return errorJson(
        c,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header required (>= 8 chars)",
      );
    }

    // Load transaction row
    const [txRow] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.transactionId, parsed.transactionId))
      .limit(1);

    // Ownership check: reject if tx belongs to another merchant (prevents IDOR)
    if (!txRow || txRow.tenantId !== auth.tenant.tenantId) {
      return errorJson(c, 404, "NOT_FOUND", "transaction not found");
    }

    const actor = { kind: "merchant" as const, merchantId: auth.merchantId };
    const result = await executeRefund({ db, registry, logger }, actor, {
      txRow,
      amountMicros: BigInt(parsed.amountMicros),
      idempotencyKey,
      reason: parsed.reason,
    });

    if (result.state === "exceeds_remaining") {
      return errorJson(
        c,
        400,
        "REFUND_EXCEEDS_REMAINING",
        "requested exceeds remaining refundable",
      );
    }
    if (result.state === "provider_unknown") {
      return errorJson(c, 500, "PROVIDER_UNKNOWN", "no adapter for provider");
    }
    if (result.state === "unsupported") {
      return errorJson(c, 501, result.code, result.message);
    }
    if (result.state === "failed") {
      return errorJson(c, 502, result.code, result.message);
    }
    if (result.state === "pending") {
      return c.json({
        apiVersion: API_VERSION,
        data: { state: "pending", pendingId: result.pendingId },
      });
    }
    if (result.state === "pending_webhook") {
      c.status(202);
      return c.json({
        apiVersion: API_VERSION,
        data: { state: "pending_webhook", transactionId: result.transactionId },
      });
    }

    return c.json({
      apiVersion: API_VERSION,
      data: {
        state: result.inserted ? "completed" : "duplicate",
        entryId: result.entryId,
        providerRefundId: result.providerRefundId,
        refundedAmountMicros: parsed.amountMicros,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api-keys — mint a new API key (JWT/admin plane ONLY)
  // Rejects api_key plane to prevent key-minting-key escalation.
  // merchantId always from auth context (never body).
  // Minted scopes must be subset of caller's scopes.
  // Per-merchant DB-counted cap prevents abuse (durable, multi-instance-safe).
  // -------------------------------------------------------------------------
  app.post("/api-keys", requirePlane("jwt"), requireScope(SCOPES.KEY_MANAGE), async (c) => {
    const auth = c.get("paykitAuth") as PaykitAuthContext;

    let parsed: z.infer<typeof MintApiKeyBody>;
    try {
      const body = await c.req.json();
      parsed = MintApiKeyBody.parse(body);
    } catch (err) {
      return errorJson(c, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : "bad body");
    }

    // Scope escalation prevention: minted scopes must be subset of caller's
    if (!isScopeSubset(parsed.scopes, auth.scopes)) {
      return errorJson(c, 403, "SCOPE_ESCALATION", "requested scopes exceed caller permissions");
    }

    // Per-merchant DB-counted cap (durable, survives restart)
    const activeCount = await apiKeyRepo.countActiveByMerchant(db, auth.merchantId);
    if (activeCount >= MAX_ACTIVE_KEYS_PER_MERCHANT) {
      return errorJson(
        c,
        429,
        "KEY_LIMIT_EXCEEDED",
        `merchant has ${activeCount} active keys (max ${MAX_ACTIVE_KEYS_PER_MERCHANT})`,
      );
    }

    // Mint key — merchantId from auth context, never from body
    const minted = mintApiKey({
      merchantId: auth.merchantId,
      mode: parsed.mode,
      scopes: parsed.scopes as Parameters<typeof mintApiKey>[0]["scopes"],
    });

    // Persist the key record. created_by records the minting principal for
    // attribution — on the jwt plane that is the authenticated admin merchant.
    const record = await apiKeyRepo.insert(db, {
      merchantId: minted.record.merchantId,
      keyHash: minted.record.keyHash,
      keyPrefix: minted.record.keyPrefix,
      mode: minted.record.mode,
      scopes: minted.record.scopes,
      createdBy: `jwt:${auth.merchantId}`,
    });

    // Return plaintext exactly once — never stored or retrievable again
    return c.json({
      apiVersion: API_VERSION,
      data: {
        keyId: record.keyId,
        keyPrefix: record.keyPrefix,
        plaintext: minted.plaintext,
        scopes: record.scopes,
        mode: record.mode,
        createdAt: record.createdAt.toISOString(),
      },
    });
  });

  return app;
}
