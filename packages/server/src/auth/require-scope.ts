/**
 * Scope enforcement middleware — returns 403 if the authenticated context
 * lacks the required scope(s). Must run AFTER apiKeyAuthMiddleware or
 * jwtAuthMiddleware has set paykitAuth on the context.
 *
 * Optionally enforces plane restriction (e.g. KEY_MANAGE = jwt-only).
 */
import type { MiddlewareHandler } from "hono";
import { hasScope } from "@vibecc/paykit-auth-core/auth/scope.js";
import type { AuthPlane } from "./auth-context.js";
import { errorJson } from "../routes/shared/response.js";

// ---------------------------------------------------------------------------
// requireScope — middleware factory
// ---------------------------------------------------------------------------

export interface RequireScopeOpts {
  /** One or more scopes that must ALL be present. */
  readonly scopes: readonly string[];
  /** If set, restricts to a specific auth plane (e.g. "jwt" for key management). */
  readonly plane?: AuthPlane;
}

/**
 * Returns a middleware that checks paykitAuth.scopes contains all required scopes.
 * 401 if no auth context; 403 if scopes insufficient or wrong plane.
 */
export function requireScope(opts: RequireScopeOpts | string): MiddlewareHandler {
  const normalized: RequireScopeOpts =
    typeof opts === "string" ? { scopes: [opts] } : opts;

  return async (c, next) => {
    const auth = c.get("paykitAuth");
    if (!auth) {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    // Plane restriction: reject if auth plane doesn't match required plane
    if (normalized.plane && auth.plane !== normalized.plane) {
      return errorJson(c, 403, "FORBIDDEN", "insufficient permissions");
    }

    // Scope check using deny-by-default hasScope
    const record = { scopes: auth.scopes as string[] };
    if (!hasScope(record, ...normalized.scopes)) {
      return errorJson(c, 403, "FORBIDDEN", "insufficient permissions");
    }

    await next();
  };
}

/**
 * Convenience: plane guard middleware — rejects requests from the wrong plane.
 * Use on route groups to enforce plane separation without scope checks.
 */
export function requirePlane(plane: AuthPlane): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("paykitAuth");
    if (!auth) {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }
    if (auth.plane !== plane) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid authentication method");
    }
    await next();
  };
}
