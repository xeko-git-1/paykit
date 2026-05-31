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
import type { PaykitAuthContext } from "./auth-context.js";
import { errorJson } from "../routes/shared/response.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface JwtSecretLoader {
  /** Returns the current JWT signing secret. Throws if unavailable or invalid. */
  (): Promise<string>;
}

export interface JwtAuthDeps {
  /** Loads the HS256 secret from runtime_config (with caching). */
  readonly loadSecret: JwtSecretLoader;
  /** Expected issuer claim value. */
  readonly expectedIssuer: string;
  /** Expected audience claim value. */
  readonly expectedAudience: string;
}

// ---------------------------------------------------------------------------
// Secret loader factory — reads from runtime_config, caches with TTL
// ---------------------------------------------------------------------------

export interface SecretLoaderDeps {
  readonly getKey: (db: unknown, key: string) => Promise<{ value: string } | undefined>;
  readonly setKey: (db: unknown, input: { key: string; value: string; expiresAt?: Date | null }) => Promise<{ value: string }>;
  readonly db: unknown;
  readonly configKey?: string;
}

const MIN_SECRET_BYTES = 32;
const CACHE_TTL_MS = 60_000; // 1 minute cache

/**
 * Creates a secret loader that reads from runtime_config and caches.
 * On first call, if no secret exists, generates a cryptographically random
 * secret of at least 32 bytes and seeds it. Fails fast if existing secret
 * is too short.
 */
export function createJwtSecretLoader(deps: SecretLoaderDeps): JwtSecretLoader {
  const { getKey, setKey, db, configKey = "jwt_signing_secret" } = deps;
  let cached: { secret: string; expiresAt: number } | null = null;

  return async (): Promise<string> => {
    // Return cached if still valid
    if (cached && Date.now() < cached.expiresAt) {
      return cached.secret;
    }

    const row = await getKey(db, configKey);

    if (row) {
      // Validate minimum length
      if (Buffer.byteLength(row.value, "utf8") < MIN_SECRET_BYTES) {
        throw new Error(
          `JWT secret in runtime_config is too short (< ${MIN_SECRET_BYTES} bytes). ` +
          "Rotate to a longer secret before starting the service.",
        );
      }
      cached = { secret: row.value, expiresAt: Date.now() + CACHE_TTL_MS };
      return row.value;
    }

    // No secret exists — generate and seed one
    const { randomBytes } = await import("node:crypto");
    const newSecret = randomBytes(48).toString("base64url"); // 48 bytes → 64 chars base64url
    const result = await setKey(db, { key: configKey, value: newSecret, expiresAt: null });
    cached = { secret: result.value, expiresAt: Date.now() + CACHE_TTL_MS };
    return result.value;
  };
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

    const authContext: PaykitAuthContext = {
      merchantId,
      tenant: { tenantId, ownerId },
      scopes,
      plane: "jwt",
    };
    c.set("paykitAuth", authContext);

    await next();
  };
}
