/**
 * mintAdminJwt — signs a short-lived admin JWT for the jwt auth plane.
 *
 * Used by the CLI `jwt mint` bootstrap path (and, later, dashboard login) to
 * produce a token that can call jwt-plane routes like POST /v1/api-keys. Claims
 * mirror exactly what jwtAuthMiddleware verifies (HS256, iss/aud, sub→tenant),
 * so a token minted here verifies against the service without drift.
 *
 * The signing secret must be the same one the service loads from runtime_config
 * (see createJwtSecretLoader) — callers are responsible for passing it in.
 */
import { sign } from "hono/jwt";
import { JWT_AUDIENCE, JWT_ISSUER } from "./jwt-claims.js";

export interface MintAdminJwtOpts {
  /** Subject merchant — becomes sub, tenant_id, owner_id. */
  readonly merchantId: string;
  /** HS256 signing secret (>= 32 bytes), loaded from runtime_config. */
  readonly secret: string;
  /** Token lifetime in seconds. */
  readonly ttlSeconds: number;
  /** Scopes the token carries — bounds what keys it can mint (subset check). */
  readonly scopes: readonly string[];
}

export async function mintAdminJwt(opts: MintAdminJwtOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: opts.merchantId,
      tenant_id: opts.merchantId,
      owner_id: opts.merchantId,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      scopes: [...opts.scopes],
      iat: now,
      exp: now + opts.ttlSeconds,
    },
    opts.secret,
    "HS256",
  );
}
