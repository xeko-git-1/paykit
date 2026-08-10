/**
 * JWT auth middleware for Hono (dashboard/frontend plane).
 *
 * Uses hono/jwt built-in verify (HS256 pinned). Rejects:
 * - alg:none tokens (algorithm confusion attack)
 * - Non-HS256 signed tokens (HS/RS confusion prevention)
 * - Missing or mismatched iss/aud claims
 * - Expired tokens (exp claim)
 * - Secrets shorter than 32 bytes
 *
 * Secret is loaded from DB runtime_config via an injected loader function,
 * enabling rotation without restart.
 */
import type { MiddlewareHandler } from "hono";
import { verify, decode } from "hono/jwt";
import {
  createJwtSecretLoader,
  type JwtSecretLoader,
  type SecretLoaderDeps,
} from "@xeko-git-1/paykit-auth-core/auth/jwt-secret-loader.js";
import type { PaykitAuthContext } from "./auth-context.js";
import { errorJson } from "../routes/shared/response.js";

// Re-exported for back-compat: the secret loader now lives in auth-core (it is
// HTTP-free and shared with the CLI), but consumers still import it from here.
export { createJwtSecretLoader };
export type { JwtSecretLoader, SecretLoaderDeps };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface JwtAuthDeps {
  /** Loads the HS256 secret from runtime_config (with caching). */
  readonly loadSecret: JwtSecretLoader;
  /** Expected issuer claim value. */
  readonly expectedIssuer: string;
  /** Expected audience claim value. */
  readonly expectedAudience: string;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function jwtAuthMiddleware(deps: JwtAuthDeps): MiddlewareHandler {
  const { loadSecret, expectedIssuer, expectedAudience } = deps;

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return errorJson(c, 401, "AUTH_INVALID", "invalid authorization header");
    }

    const token = parts[1]!;

    // Reject API keys on JWT routes (plane separation)
    if (token.startsWith("pk_")) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid token format");
    }

    // Decode header first to enforce algorithm before verification.
    // This prevents alg:none and HS/RS confusion attacks structurally.
    let decoded: { header: { alg?: string }; payload: Record<string, unknown> };
    try {
      decoded = decode(token) as { header: { alg?: string }; payload: Record<string, unknown> };
    } catch {
      return errorJson(c, 401, "AUTH_INVALID", "malformed token");
    }

    // Pin to HS256 — reject alg:none, RS256, ES256, or any other algorithm
    if (!decoded.header.alg || decoded.header.alg !== "HS256") {
      return errorJson(c, 401, "AUTH_INVALID", "unsupported token algorithm");
    }

    // Load secret from runtime_config
    let secret: string;
    try {
      secret = await loadSecret();
    } catch {
      // Secret unavailable or too short — service cannot authenticate
      return errorJson(c, 500, "AUTH_CONFIG_ERROR", "authentication service unavailable");
    }

    // Verify signature + expiration with hono/jwt (HS256 pinned)
    let payload: Record<string, unknown>;
    try {
      payload = (await verify(token, secret, "HS256")) as Record<string, unknown>;
    } catch {
      return errorJson(c, 401, "AUTH_INVALID", "token verification failed");
    }

    // Validate required claims: iss and aud
    if (payload.iss !== expectedIssuer) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid token issuer");
    }
    if (payload.aud !== expectedAudience) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid token audience");
    }

    // Extract tenant info from JWT claims
    const merchantId = payload.sub as string | undefined;
    const tenantId = (payload.tenant_id ?? payload.sub) as string | undefined;
    const ownerId = (payload.owner_id ?? payload.sub) as string | undefined;

    if (!merchantId || !tenantId || !ownerId) {
      return errorJson(c, 401, "AUTH_INVALID", "token missing required claims");
    }

    const scopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];

    // keyId for rate-limiting: JWT plane has no per-key identity, so we use a
    // namespaced merchantId to keep its bucket separate from api_key buckets.
    const keyId = `jwt:${merchantId}`;

    const authContext: PaykitAuthContext = {
      merchantId,
      tenant: { tenantId, ownerId },
      scopes,
      plane: "jwt",
      keyId,
    };
    c.set("paykitAuth", authContext);

    await next();
  };
}
