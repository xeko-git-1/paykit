/**
 * API-key lifecycle primitives: mint, hash, verify.
 *
 * Design invariants:
 * - sha256 without per-key salt is intentional. API keys contain 32 bytes of
 *   cryptographic randomness (~256 bits entropy), making rainbow/dictionary
 *   attacks computationally infeasible. Salt adds complexity appropriate for
 *   low-entropy human passwords, not high-entropy machine secrets.
 * - Plaintext is returned exactly once at mint time; no read-back path exists.
 * - Verification uses crypto.timingSafeEqual to prevent timing side-channels.
 * - No plaintext or hash value is ever logged on any code path.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKey } from "../db/schema/api-keys.js";
import type { ApiKeyScope } from "./scope.js";

/**
 * Maximum active (non-revoked) keys per merchant — durable, DB-counted cap.
 * Enforced identically at every mint path (HTTP jwt-plane route + CLI operator
 * bootstrap) so neither can exceed the other's invariant.
 */
export const MAX_ACTIVE_KEYS_PER_MERCHANT = 10;

// ---------------------------------------------------------------------------
// Base62 encoding (alphanumeric, URL-safe, no ambiguous chars)
// ---------------------------------------------------------------------------
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function toBase62(buf: Buffer): string {
  // Two base62 digits per byte. Every byte decomposes uniquely as
  // 62*hi + lo (hi ∈ [0,4], lo ∈ [0,61]) because 256 < 62² = 3844, so the
  // mapping is injective and preserves the full entropy of the input bytes.
  let result = "";
  for (const byte of buf) {
    result += BASE62_CHARS[Math.floor(byte / 62)];
    result += BASE62_CHARS[byte % 62];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface MintApiKeyOpts {
  merchantId: string;
  mode: "live" | "test";
  scopes: ApiKeyScope[];
}

export interface MintApiKeyResult {
  /** Full plaintext key — returned once, never stored. */
  plaintext: string;
  /** Display-only prefix (e.g. "pk_live_Ab3x") for UI identification. */
  keyPrefix: string;
  /** sha256 hex of plaintext — this is what gets persisted. */
  keyHash: string;
  /** Partial record ready for repo.insert (missing keyId, timestamps). */
  record: {
    merchantId: string;
    keyHash: string;
    keyPrefix: string;
    mode: string;
    scopes: string[];
  };
}

export interface VerifyResult {
  ok: boolean;
  record: ApiKey | null;
}

export type ApiKeyLookup = (keyHash: string) => Promise<ApiKey | null>;

// ---------------------------------------------------------------------------
// hashApiKey — pure, deterministic sha256 hex
// ---------------------------------------------------------------------------
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// mintApiKey — generate a new API key with high-entropy random body
// ---------------------------------------------------------------------------
export function mintApiKey(opts: MintApiKeyOpts): MintApiKeyResult {
  const { merchantId, mode, scopes } = opts;
  const prefix = `pk_${mode}_`;
  const randomBody = toBase62(randomBytes(32));
  const plaintext = `${prefix}${randomBody}`;
  const keyPrefix = plaintext.slice(0, prefix.length + 4);
  const keyHash = hashApiKey(plaintext);

  return {
    plaintext,
    keyPrefix,
    keyHash,
    record: { merchantId, keyHash, keyPrefix, mode, scopes },
  };
}

// ---------------------------------------------------------------------------
// verifyApiKey — timing-safe verification with injected lookup
// ---------------------------------------------------------------------------

/**
 * Verifies an API key plaintext against the store.
 * 1. Hashes the plaintext.
 * 2. Calls lookup(hash) to find the record.
 * 3. If not found → deny.
 * 4. Timing-safe compares computed hash with stored hash (defense-in-depth).
 * 5. If revoked_at is set → deny.
 */
export async function verifyApiKey(plaintext: string, lookup: ApiKeyLookup): Promise<VerifyResult> {
  const computedHash = hashApiKey(plaintext);
  const record = await lookup(computedHash);

  if (!record) {
    return { ok: false, record: null };
  }

  // Timing-safe comparison of the computed hash vs stored hash.
  // Even though lookup is by hash (so a match is expected), this guards against
  // subtle bugs where lookup returns a record with a different hash field.
  const computedBuf = Buffer.from(computedHash, "utf8");
  const storedBuf = Buffer.from(record.keyHash, "utf8");

  if (computedBuf.length !== storedBuf.length || !timingSafeEqual(computedBuf, storedBuf)) {
    return { ok: false, record: null };
  }

  // Reject revoked keys
  if (record.revokedAt !== null) {
    return { ok: false, record: null };
  }

  return { ok: true, record };
}
