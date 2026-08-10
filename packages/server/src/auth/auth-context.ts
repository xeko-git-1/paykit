/**
 * Auth context types and helpers for the Hono middleware pipeline.
 *
 * Two auth planes exist:
 * - "api_key": server-to-server calls on /v1 routes, resolved from Bearer pk_... header
 * - "jwt": dashboard/frontend calls, resolved from Bearer <jwt> header
 *
 * Route handlers read tenant via `authTenant(c)` instead of calling tenantResolver
 * directly. In service mode (no tenantResolver), missing paykitAuth = 401 immediately.
 * In embedded mode, the tenantResolver fallback is still available.
 */
import type { Context } from "hono";
import type { ResolvedTenant } from "@xeko-git-1/paykit";
import { errorJson } from "../routes/shared/response.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthPlane = "api_key" | "jwt";

export interface PaykitAuthContext {
  readonly merchantId: string;
  readonly tenant: ResolvedTenant;
  readonly scopes: readonly string[];
  readonly plane: AuthPlane;
  /**
   * Identifier the rate limiter buckets on. The api_key plane sets the key's
   * id; the jwt plane sets a namespaced `jwt:<merchantId>` so its buckets never
   * collide with api-key ids. Two keys of one merchant throttle independently.
   */
  readonly keyId?: string;
}

// ---------------------------------------------------------------------------
// Hono ContextVariableMap augmentation (mirrors admin-guard.ts pattern)
// ---------------------------------------------------------------------------

declare module "hono" {
  interface ContextVariableMap {
    paykitAuth: PaykitAuthContext;
  }
}

// ---------------------------------------------------------------------------
// authTenant — unified tenant accessor for route handlers
// ---------------------------------------------------------------------------

/**
 * Reads the authenticated tenant from the Hono context.
 * Returns the ResolvedTenant if paykitAuth is set, or null if absent.
 *
 * Route handlers in service mode must treat null as 401 (fail-closed).
 * Embedded mode may fall back to tenantResolver when this returns null.
 */
export function getAuthTenant(c: Context): ResolvedTenant | null {
  const auth = c.get("paykitAuth");
  if (!auth) return null;
  return auth.tenant;
}

/**
 * Reads the authenticated tenant, returning 401 if absent.
 * Use this in service-mode routes where auth middleware is mandatory.
 * Service mode never resolves tenant from a caller-controlled header —
 * auth is the only tenant source.
 */
export function authTenant(c: Context): ResolvedTenant | Response {
  const auth = c.get("paykitAuth");
  if (!auth) {
    return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
  }
  return auth.tenant;
}

/**
 * Type guard: checks if authTenant result is a Response (error) vs ResolvedTenant.
 */
export function isAuthError(result: ResolvedTenant | Response): result is Response {
  return result instanceof Response;
}
