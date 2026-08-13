import { hashApiKey, verifyApiKey } from "@xeko-git-1/paykit-auth-core/auth/api-key.js";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
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
import { errorJson } from "../routes/shared/response.js";
import type { PaykitAuthContext } from "./auth-context.js";

// ---------------------------------------------------------------------------
// Dependencies — injected for testability
// ---------------------------------------------------------------------------

export interface ApiKeyAuthDeps {
  readonly db: DbClient;
  /** Lookup function: (db, keyHash) => ApiKey | null */
  readonly findByHash: (
    db: DbClient,
    keyHash: string,
  ) => Promise<{
    keyId: string;
    merchantId: string;
    keyHash: string;
    keyPrefix: string;
    mode: string;
    scopes: string[];
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    createdBy: string | null;
  } | null>;
  /** Fire-and-forget last-used timestamp update */
  readonly touchLastUsed: (db: DbClient, keyId: string) => Promise<void>;
  /** Resolve merchantId → tenant mapping. In V4.0, merchantId IS the tenantId. */
  readonly resolveMerchantTenant: (
    merchantId: string,
  ) => Promise<{ tenantId: string; ownerId: string } | null>;
  /**
   * Load the merchant's lifecycle status (`merchants.status`), or null when the
   * merchant row does not exist. Optional because embedded consumers may not
   * use the merchants table at all; when omitted, no status check runs. A
   * `suspended` merchant is rejected with 403 — the key itself is valid, but
   * the account behind it is not allowed to transact, and revoking every key
   * would destroy state the operator wants back on reactivation.
   */
  readonly loadMerchantStatus?: (db: DbClient, merchantId: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function apiKeyAuthMiddleware(deps: ApiKeyAuthDeps): MiddlewareHandler {
  const { db, findByHash, touchLastUsed, resolveMerchantTenant, loadMerchantStatus } = deps;

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return errorJson(c, 401, "AUTH_REQUIRED", "authentication required");
    }

    // Expect "Bearer pk_..." format
    const [scheme, plaintext, ...rest] = authHeader.split(" ");
    if (scheme !== "Bearer" || plaintext === undefined || rest.length > 0) {
      return errorJson(c, 401, "AUTH_INVALID", "invalid authorization header");
    }
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

    // Enforce merchant suspension AFTER the key verified: 403 (identity known,
    // access denied), not 401, so a suspended merchant's tooling shows the real
    // reason instead of retrying credentials. A missing status (null) passes —
    // that is "no lifecycle managed here", not "suspended".
    if (loadMerchantStatus !== undefined) {
      const status = await loadMerchantStatus(db, record.merchantId);
      if (status === "suspended") {
        return errorJson(c, 403, "MERCHANT_SUSPENDED", "merchant account is suspended");
      }
    }

    // Set auth context on Hono context
    const authContext: PaykitAuthContext = {
      merchantId: record.merchantId,
      tenant,
      scopes: record.scopes,
      plane: "api_key",
      keyId: record.keyId,
    };
    c.set("paykitAuth", authContext);

    // Fire-and-forget: update last_used_at for audit trail
    touchLastUsed(db, record.keyId).catch(() => {
      // Non-fatal — never block auth decision on audit write
    });

    await next();
  };
}
