/**
 * API-key auth middleware for Hono.
 *
 * Reads `Authorization: Bearer pk_...` header, hashes the key, looks up via
 * apiKeyRepo.findByHash, verifies with timing-safe compare, and sets
 * `paykitAuth` on the Hono context with plane "api_key".
 *
 * 401 on missing/invalid/revoked key. Never leaks internal details.
 * Mirrors the adminGuardMiddleware shape (declare-module + errorJson).
 */
import type { MiddlewareHandler } from "hono";
import type { DbClient } from "../db/client.js";
import { hashApiKey, verifyApiKey } from "./api-key.js";
import type { PaykitAuthContext } from "./auth-context.js";
import { errorJson } from "../routes/shared/response.js";

// ---------------------------------------------------------------------------
// Dependencies — injected for testability
// ---------------------------------------------------------------------------

export interface ApiKeyAuthDeps {
  readonly db: DbClient;
  /** Lookup function: (db, keyHash) => ApiKey | null */
  readonly findByHash: (db: DbClient, keyHash: string) => Promise<{
    keyId: string;
    merchantId: string;
    keyHash: string;
    keyPrefix: string;
    mode: string;
    scopes: string[];
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  } | null>;
  /** Fire-and-forget last-used timestamp update */
  readonly touchLastUsed: (db: DbClient, keyId: string) => Promise<void>;
  /** Resolve merchantId → tenant mapping. In V4.0, merchantId IS the tenantId. */
  readonly resolveMerchantTenant: (merchantId: string) => Promise<{ tenantId: string; ownerId: string } | null>;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function apiKeyAuthMiddleware(deps: ApiKeyAuthDeps): MiddlewareHandler {
  const { db, findByHash, touchLastUsed, resolveMerchantTenant } = deps;

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    // Expect "Bearer pk_..." format
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return errorJson(c, 401, "AUTH_INVALID", "invalid authorization header");
    }

    const plaintext = parts[1]!;
    if (!plaintext.startsWith("pk_")) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid key format");
    }

    // Verify the key using timing-safe comparison
    const result = await verifyApiKey(plaintext, (keyHash) => findByHash(db, keyHash));
    if (!result.ok || !result.record) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid or revoked api key");
    }

    const record = result.record;

    // Resolve merchant → tenant mapping
    const tenant = await resolveMerchantTenant(record.merchantId);
    if (!tenant) {
      return errorJson(c, 401, "AUTH_INVALID", "merchant not found");
    }

    // Set auth context on Hono context
    const authContext: PaykitAuthContext = {
      merchantId: record.merchantId,
      tenant,
      scopes: record.scopes,
      plane: "api_key",
    };
    c.set("paykitAuth", authContext);

    // Fire-and-forget: update last_used_at for audit trail
    touchLastUsed(db, record.keyId).catch(() => {
      // Non-fatal — never block auth decision on audit write
    });

    await next();
  };
}
