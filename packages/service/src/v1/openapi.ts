/**
 * OpenAPI 3.1 spec generation for /v1 API surface.
 *
 * Uses @hono/zod-openapi to derive the spec from zod schemas defined in dto.ts.
 * Served at GET /v1/openapi.json — no auth required (public documentation).
 */
import { OpenAPIHono, createRoute, z as oz } from "@hono/zod-openapi";
import {
  API_VERSION,
  BalanceResponse,
  CheckoutResponse,
  CreateCheckoutBody,
  CreateRefundBody,
  ErrorEnvelope,
  MintApiKeyBody,
  MintApiKeyResponse,
  PaymentsQueryParams,
  PaymentsResponse,
  RefundResponse,
} from "./dto.js";

// ---------------------------------------------------------------------------
// Route definitions (for spec generation — handlers are in router.ts)
// ---------------------------------------------------------------------------

const checkoutRoute = createRoute({
  method: "post",
  path: "/v1/checkouts",
  summary: "Create a payment checkout session",
  request: { body: { content: { "application/json": { schema: CreateCheckoutBody } } } },
  responses: {
    200: { description: "Checkout created", content: { "application/json": { schema: CheckoutResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Insufficient scope", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

const balancesRoute = createRoute({
  method: "get",
  path: "/v1/balances",
  summary: "List currency balances for the authenticated merchant",
  responses: {
    200: { description: "Balances list", content: { "application/json": { schema: BalanceResponse } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Insufficient scope", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

const paymentsRoute = createRoute({
  method: "get",
  path: "/v1/payments",
  summary: "List payment transactions for the authenticated merchant",
  request: { query: PaymentsQueryParams },
  responses: {
    200: { description: "Payments list", content: { "application/json": { schema: PaymentsResponse } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Insufficient scope", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

const refundsRoute = createRoute({
  method: "post",
  path: "/v1/refunds",
  summary: "Initiate a refund for a transaction owned by the authenticated merchant",
  request: {
    headers: oz.object({
      "Idempotency-Key": oz
        .string()
        .min(8)
        .openapi({
          param: { name: "Idempotency-Key", in: "header", required: true },
          example: "refund-2026-05-31-0001",
        }),
    }),
    body: { content: { "application/json": { schema: CreateRefundBody } } },
  },
  responses: {
    200: { description: "Refund processed", content: { "application/json": { schema: RefundResponse } } },
    202: { description: "Refund accepted (async)", content: { "application/json": { schema: RefundResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorEnvelope } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Insufficient scope", content: { "application/json": { schema: ErrorEnvelope } } },
    404: { description: "Transaction not found or not owned", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

const mintApiKeyRoute = createRoute({
  method: "post",
  path: "/v1/api-keys",
  summary: "Mint a new API key (JWT/admin plane only)",
  request: { body: { content: { "application/json": { schema: MintApiKeyBody } } } },
  responses: {
    200: { description: "Key minted", content: { "application/json": { schema: MintApiKeyResponse } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorEnvelope } } },
    401: { description: "Authentication required or wrong plane", content: { "application/json": { schema: ErrorEnvelope } } },
    403: { description: "Scope escalation", content: { "application/json": { schema: ErrorEnvelope } } },
    429: { description: "Key limit exceeded or rate limited", content: { "application/json": { schema: ErrorEnvelope } } },
  },
});

// ---------------------------------------------------------------------------
// OpenAPI document generation
// ---------------------------------------------------------------------------

export function getOpenAPIDocument(): unknown {
  const openapiApp = new OpenAPIHono();

  // Bearer auth scheme — SDKs need this to know /v1 requires a token. Both
  // planes present as `Authorization: Bearer <token>` (api-key pk_… or jwt).
  openapiApp.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key (pk_live_… / pk_test_…) or admin JWT, sent as a Bearer token.",
  });

  // Register routes with no-op handlers (spec generation only)
  openapiApp.openapi(checkoutRoute, (c) => c.json({} as never));
  openapiApp.openapi(balancesRoute, (c) => c.json({} as never));
  openapiApp.openapi(paymentsRoute, (c) => c.json({} as never));
  openapiApp.openapi(refundsRoute, (c) => c.json({} as never));
  openapiApp.openapi(mintApiKeyRoute, (c) => c.json({} as never));

  return openapiApp.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Paykit Public API",
      version: API_VERSION,
      description: "Versioned public API for Paykit payment processing",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
  });
}
