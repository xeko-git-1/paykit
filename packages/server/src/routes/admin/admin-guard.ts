/**
 * Admin guard middleware — wraps an `AdminGuard` callback into a Hono
 * middleware that returns 403 on falsy `allowed`, 500 on guard throw.
 *
 * Stores `adminContext` on the Hono context for downstream routes to access
 * `adminUserId` / `role` for audit logging.
 */
import type { AdminGuard, AdminGuardResult } from "@xeko-git-1/paykit";
import type { MiddlewareHandler } from "hono";
import { errorJson } from "../shared/response.js";

declare module "hono" {
  interface ContextVariableMap {
    adminContext: AdminGuardResult;
  }
}

export function adminGuardMiddleware(guard: AdminGuard): MiddlewareHandler {
  return async (c, next) => {
    let result: AdminGuardResult;
    try {
      result = await guard(c.req.raw);
    } catch {
      // Never leak the guard's stack trace to clients.
      return errorJson(c, 500, "ADMIN_GUARD_ERROR", "admin guard failed");
    }
    if (!result.allowed) {
      return errorJson(c, 403, "FORBIDDEN", "admin access required");
    }
    c.set("adminContext", result);
    await next();
  };
}
