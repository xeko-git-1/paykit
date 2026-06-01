/**
 * Bootstrap operations for the paykit CLI operator path.
 *
 * These run with a direct DB connection (DB-URL = tier-0 operator secret) and
 * do NOT require the service to be up. They solve the chicken-and-egg of the
 * jwt mint plane: an operator creates the first merchant + first API key here,
 * then can mint an admin JWT to use the HTTP /v1/api-keys route thereafter.
 *
 * Trust boundary: anyone holding the DB URL is already a tier-0 operator, so
 * --merchant cross-tenant minting is allowed; created_by records who did it.
 *
 * Plaintext secrets (API keys, JWTs) are returned to the caller for one-time
 * display only — never logged here.
 */
import {
  type DbClient,
  MAX_ACTIVE_KEYS_PER_MERCHANT,
  SCOPES,
  apiKeyRepo,
  createJwtSecretLoader,
  merchantRepo,
  mintAdminJwt,
  mintApiKey,
  runtimeConfigRepo,
} from "@vibecc/paykit-server";

// Valid scope strings, derived from the server's canonical SCOPES map.
const VALID_SCOPES = new Set<string>(Object.values(SCOPES));

// ---------------------------------------------------------------------------
// createMerchant
// ---------------------------------------------------------------------------

export async function createMerchant(db: DbClient, name: string): Promise<{ merchantId: string }> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("merchant name must not be empty");
  }
  const row = await merchantRepo.insert(db, { name: trimmed });
  return { merchantId: row.merchantId };
}

// ---------------------------------------------------------------------------
// mintKey — operator-side API-key mint (mirrors HTTP invariants)
// ---------------------------------------------------------------------------

export interface MintKeyInput {
  readonly merchantId: string;
  readonly scopes: readonly string[];
  readonly mode: "live" | "test";
}

export interface MintKeyResult {
  readonly keyId: string;
  readonly keyPrefix: string;
  readonly plaintext: string;
  readonly scopes: readonly string[];
  readonly mode: string;
}

export async function mintKey(db: DbClient, input: MintKeyInput): Promise<MintKeyResult> {
  if (input.scopes.length === 0) {
    throw new Error("at least one scope is required");
  }

  // Reject unknown scopes — deny-by-default, same vocabulary as the HTTP plane.
  const unknown = input.scopes.filter((s) => !VALID_SCOPES.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scope(s): ${unknown.join(", ")}. Valid scopes: ${[...VALID_SCOPES].join(", ")}`,
    );
  }

  // Merchant must exist (FK would reject anyway, but a clear error is friendlier).
  const merchant = await merchantRepo.findById(db, input.merchantId);
  if (!merchant) {
    throw new Error(`merchant not found: ${input.merchantId}`);
  }

  // Per-merchant active-key cap — identical invariant to the HTTP route, so the
  // operator path cannot quietly exceed what the API enforces.
  const activeCount = await apiKeyRepo.countActiveByMerchant(db, input.merchantId);
  if (activeCount >= MAX_ACTIVE_KEYS_PER_MERCHANT) {
    throw new Error(
      `merchant has ${activeCount} active keys (max ${MAX_ACTIVE_KEYS_PER_MERCHANT}); revoke one before minting`,
    );
  }

  const minted = mintApiKey({
    merchantId: input.merchantId,
    mode: input.mode,
    scopes: input.scopes as Parameters<typeof mintApiKey>[0]["scopes"],
  });

  const record = await apiKeyRepo.insert(db, {
    merchantId: minted.record.merchantId,
    keyHash: minted.record.keyHash,
    keyPrefix: minted.record.keyPrefix,
    mode: minted.record.mode,
    scopes: minted.record.scopes,
    createdBy: "cli:operator",
  });

  return {
    keyId: record.keyId,
    keyPrefix: record.keyPrefix,
    plaintext: minted.plaintext,
    scopes: record.scopes,
    mode: record.mode,
  };
}

// ---------------------------------------------------------------------------
// mintJwt — operator-side admin JWT mint (bridge to HTTP /v1/api-keys)
// ---------------------------------------------------------------------------

export interface MintJwtInput {
  readonly merchantId: string;
  readonly ttlSeconds: number;
  /** Scopes the admin JWT carries; defaults to key:manage so it can mint keys. */
  readonly scopes?: readonly string[];
}

export async function mintJwt(db: DbClient, input: MintJwtInput): Promise<{ token: string }> {
  const merchant = await merchantRepo.findById(db, input.merchantId);
  if (!merchant) {
    throw new Error(`merchant not found: ${input.merchantId}`);
  }
  if (input.ttlSeconds <= 0) {
    throw new Error("ttl must be a positive number of seconds");
  }

  // Load the same signing secret the service uses (runtime_config), seeding it
  // if absent — so a token minted before first service boot still verifies.
  const loadSecret = createJwtSecretLoader({
    getKey: runtimeConfigRepo.getKey as (
      db: unknown,
      key: string,
    ) => Promise<{ value: string } | undefined>,
    claimKey: runtimeConfigRepo.claimKey as (
      db: unknown,
      i: { key: string; value: string; expiresAt?: Date | null },
    ) => Promise<{ value: string }>,
    db,
  });
  const secret = await loadSecret();

  const token = await mintAdminJwt({
    merchantId: input.merchantId,
    secret,
    ttlSeconds: input.ttlSeconds,
    scopes: input.scopes ?? [SCOPES.KEY_MANAGE],
  });
  return { token };
}
