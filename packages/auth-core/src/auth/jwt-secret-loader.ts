/**
 * JWT signing-secret loader — reads/seeds the HS256 secret from runtime_config.
 *
 * HTTP-free (only node:crypto): lives in auth-core so both the server's JWT
 * middleware (verify path) and the CLI `jwt mint` (sign path) share one secret
 * source without depending on the Hono layer. Caches with a short TTL and uses
 * an atomic claim so concurrent cold-boot replicas converge on one secret.
 */
/** Returns the current JWT signing secret. Throws if unavailable or invalid. */
export type JwtSecretLoader = () => Promise<string>;

export interface SecretLoaderDeps {
  readonly getKey: (db: unknown, key: string) => Promise<{ value: string } | undefined>;
  /**
   * Atomic claim: INSERT ON CONFLICT DO NOTHING + re-SELECT winner.
   * Ensures all replicas converge on the same secret during cold-boot race.
   */
  readonly claimKey: (
    db: unknown,
    input: { key: string; value: string; expiresAt?: Date | null },
  ) => Promise<{ value: string }>;
  readonly db: unknown;
  readonly configKey?: string;
}

const MIN_SECRET_BYTES = 32;
const CACHE_TTL_MS = 60_000; // 1 minute cache

/**
 * Creates a secret loader that reads from runtime_config and caches.
 * On first call, if no secret exists, generates a cryptographically random
 * secret of at least 32 bytes and atomically claims it. Fails fast if an
 * existing secret is too short.
 */
export function createJwtSecretLoader(deps: SecretLoaderDeps): JwtSecretLoader {
  const { getKey, claimKey, db, configKey = "jwt_signing_secret" } = deps;
  let cached: { secret: string; expiresAt: number } | null = null;

  return async (): Promise<string> => {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.secret;
    }

    const row = await getKey(db, configKey);

    if (row) {
      if (Buffer.byteLength(row.value, "utf8") < MIN_SECRET_BYTES) {
        throw new Error(
          `JWT secret in runtime_config is too short (< ${MIN_SECRET_BYTES} bytes). Rotate to a longer secret before starting the service.`,
        );
      }
      cached = { secret: row.value, expiresAt: Date.now() + CACHE_TTL_MS };
      return row.value;
    }

    // No secret exists — generate and atomically claim one. If another replica
    // races us, claimKey returns the winner's value (INSERT DO NOTHING + re-SELECT).
    const { randomBytes } = await import("node:crypto");
    const newSecret = randomBytes(48).toString("base64url"); // 48 bytes → 64 chars base64url
    const result = await claimKey(db, { key: configKey, value: newSecret, expiresAt: null });
    cached = { secret: result.value, expiresAt: Date.now() + CACHE_TTL_MS };
    return result.value;
  };
}
