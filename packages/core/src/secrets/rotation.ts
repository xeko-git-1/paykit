/**
 * Webhook secret rotation with grace period.
 *
 * Consumer's SecretProvider may return either string or string[]. During
 * rotation, return [oldSecret, newSecret]; both verify for `graceMs` after
 * SecretProvider switches to [newSecret, ...].
 *
 * Default grace: 5 minutes. Configurable via `webhookSecretRotationGraceMs`.
 */

export interface RotationCacheEntry {
  readonly value: string;
  readonly fetchedAt: number;
}

export interface RotationGraceConfig {
  readonly graceMs: number;
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export function defaultRotationConfig(): RotationGraceConfig {
  return { graceMs: DEFAULT_GRACE_MS };
}

/**
 * Resolve the verification list. If SecretProvider returns string, use that.
 * If returns array, use all values. Caller (webhook handler) tries each in
 * sequence and accepts on first match.
 */
export function resolveSecretsForVerify(secret: string | readonly string[]): readonly string[] {
  return Array.isArray(secret) ? (secret as readonly string[]) : [secret as string];
}
