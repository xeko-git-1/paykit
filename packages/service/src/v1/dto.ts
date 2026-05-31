/**
 * Versioned DTOs for /v1 API surface — single source of truth for request
 * and response shapes. All request schemas use .strict() to reject unknown
 * keys at the boundary (prevents accidental PAN/CVV leakage).
 *
 * These schemas feed into @hono/zod-openapi createRoute definitions,
 * so the OpenAPI spec derives directly from them — no drift possible.
 */
import { z } from "zod";

export const API_VERSION = "2026-05-31" as const;

// ---------------------------------------------------------------------------
// POST /v1/checkouts
// ---------------------------------------------------------------------------

export const CreateCheckoutBody = z
  .object({
    amountUsd: z.number().positive().min(1).max(500).optional(),
    amountVnd: z.number().int().positive().min(10_000).optional(),
    provider: z.string().min(1).max(64),
    discountCode: z.string().min(1).max(64).optional(),
  })
  .strict();

export const CheckoutResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  data: z.object({
    transactionId: z.string().uuid(),
    provider: z.string(),
    webUrl: z.string().url().optional(),
    qrUrl: z.string().url().optional(),
    mobileDeeplink: z.string().optional(),
    expiresAt: z.string().datetime(),
    discountApplied: z.boolean(),
  }),
});

// ---------------------------------------------------------------------------
// GET /v1/balances
// ---------------------------------------------------------------------------

export const BalanceResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  data: z.array(
    z.object({
      currencyCode: z.string(),
      currentBalanceMicros: z.string(),
      updatedAt: z.string().datetime().nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// GET /v1/payments
// ---------------------------------------------------------------------------

export const PaymentsQueryParams = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const PaymentsResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  data: z.array(
    z.object({
      transactionId: z.string().uuid(),
      provider: z.string(),
      amountMicros: z.string(),
      currencyCode: z.string(),
      status: z.string(),
      providerRef: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// POST /v1/refunds
// ---------------------------------------------------------------------------

export const CreateRefundBody = z
  .object({
    transactionId: z.string().uuid(),
    amountMicros: z.string().regex(/^\d+$/),
    reason: z.string().min(3).max(500),
  })
  .strict();

export const RefundResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  data: z.object({
    state: z.enum(["completed", "pending", "pending_webhook", "duplicate"]),
    entryId: z.string().optional(),
    pendingId: z.string().optional(),
    transactionId: z.string().uuid().optional(),
    providerRefundId: z.string().optional(),
    refundedAmountMicros: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------------
// POST /v1/api-keys (mint — JWT/admin plane only)
// ---------------------------------------------------------------------------

export const MintApiKeyBody = z
  .object({
    mode: z.enum(["live", "test"]).default("live"),
    scopes: z.array(z.string().min(1)).min(1),
    label: z.string().max(128).optional(),
  })
  .strict();

export const MintApiKeyResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  data: z.object({
    keyId: z.string().uuid(),
    keyPrefix: z.string(),
    plaintext: z.string(),
    scopes: z.array(z.string()),
    mode: z.string(),
    createdAt: z.string().datetime(),
  }),
});

// ---------------------------------------------------------------------------
// Error envelope (unified across all /v1 endpoints)
// ---------------------------------------------------------------------------

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
