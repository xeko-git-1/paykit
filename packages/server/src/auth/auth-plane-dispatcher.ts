/**
 * authPlaneDispatcher — routes a request to the correct auth plane by token shape.
 *
 * The api-key and jwt middlewares are intentionally mutually exclusive:
 * apiKeyAuthMiddleware rejects any non-"pk_" token, and jwtAuthMiddleware rejects
 * any "pk_" token (plane separation, defense-in-depth). Mounting both with
 * app.use() in sequence would make the first one reject the other plane's tokens.
 *
 * This dispatcher inspects the Bearer token prefix once and delegates to exactly
 * one plane: "pk_" → api-key (s2s), anything else → jwt (admin/dashboard). A
 * missing/malformed Authorization header is handled by the jwt branch's existing
 * 401 path, keeping error envelopes consistent.
 */
import type { MiddlewareHandler } from "hono";

export interface AuthPlaneDispatcherDeps {
  readonly apiKey: MiddlewareHandler;
  readonly jwt: MiddlewareHandler;
}

export function authPlaneDispatcher(deps: AuthPlaneDispatcherDeps): MiddlewareHandler {
  const { apiKey, jwt } = deps;

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.split(" ")[1];

    // API-key tokens carry the "pk_" prefix; everything else is treated as a JWT.
    // The chosen plane's middleware enforces its own format/validation and sets
    // paykitAuth (or returns 401). Only one plane ever runs per request.
    if (token?.startsWith("pk_")) {
      return apiKey(c, next);
    }
    return jwt(c, next);
  };
}
