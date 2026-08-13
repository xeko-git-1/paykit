/**
 * Rate limiter for the /v1 surface, keyed by credential (api-key id, or the
 * jwt plane's namespaced `jwt:<merchantId>`).
 *
 * Two implementations behind one middleware:
 *
 *   - **Durable fixed window on Postgres** (when `db` is supplied — the
 *     service-mode default). One UPSERT per request counts against the
 *     credential's current window, so the limit holds across every instance
 *     and every restart. No Redis: the database is already the coordination
 *     point for everything else money-shaped in this repo.
 *   - **In-memory token bucket** (no `db`, or the database errored). Honest
 *     per-process throttle — the pre-029 behavior, kept because a rate limiter
 *     that takes the API down when the database hiccups has inverted its own
 *     purpose. Degrading to per-process is the fallback, never an outage.
 *
 * Headers follow the RateLimit draft standard (X-RateLimit-Limit,
 * X-RateLimit-Remaining, X-RateLimit-Reset) on both paths.
 */
import { type DbClient, errorJson, rateLimitRepo } from "@xeko-git-1/paykit-server";
import type { MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum requests per window. Default: 100 */
  readonly maxTokens?: number;
  /** Window length in milliseconds. Default: 60_000 (1 minute) */
  readonly refillIntervalMs?: number;
  /**
   * When supplied, the count lives in paykit.rate_limit_windows and the limit
   * is authoritative across instances. Without it, the in-memory bucket
   * applies per process.
   */
  readonly db?: DbClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
}

const DEFAULT_MAX_TOKENS = 100;
const DEFAULT_REFILL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// In-memory token bucket — per-process fallback (and embedded default)
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// Resets on process restart (acceptable: it is the fallback, not the ledger)
const buckets = new Map<string, Bucket>();

function getBucket(keyId: string, maxTokens: number): Bucket {
  let bucket = buckets.get(keyId);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: Date.now() };
    buckets.set(keyId, bucket);
  }
  return bucket;
}

function refillBucket(bucket: Bucket, maxTokens: number, refillIntervalMs: number): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= refillIntervalMs) {
    const refills = Math.floor(elapsed / refillIntervalMs);
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refills * maxTokens);
    bucket.lastRefill = bucket.lastRefill + refills * refillIntervalMs;
  }
}

/** Consume one token from the per-process bucket. Returns remaining, or -1 when denied. */
function consumeInMemory(bucketKey: string, maxTokens: number, refillIntervalMs: number): number {
  const bucket = getBucket(bucketKey, maxTokens);
  refillBucket(bucket, maxTokens, refillIntervalMs);
  if (bucket.tokens <= 0) return -1;
  bucket.tokens -= 1;
  return bucket.tokens;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function rateLimitMiddleware(config: RateLimitConfig = {}): MiddlewareHandler {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const refillIntervalMs = config.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS;
  const { db, logger } = config;

  return async (c, next) => {
    const auth = c.get("paykitAuth");
    if (!auth) {
      // No auth context — let auth middleware handle rejection
      await next();
      return;
    }

    // Bucket per credential. Both planes set keyId — api_key uses the key's
    // id, jwt uses a namespaced `jwt:<merchantId>` — so two keys of one
    // merchant throttle independently. merchantId is only a defensive fallback.
    const bucketKey = auth.keyId ?? auth.merchantId;

    c.header("X-RateLimit-Limit", maxTokens.toString());

    if (db !== undefined) {
      // Durable path: one UPSERT counts this request against the credential's
      // current fixed window, exact across all instances.
      const now = Date.now();
      const windowStartMs = Math.floor(now / refillIntervalMs) * refillIntervalMs;
      let count: number;
      try {
        count = await rateLimitRepo.consumeFixedWindow(db, {
          bucketKey,
          windowStart: new Date(windowStartMs),
        });
      } catch (err) {
        // The limiter must not become the outage: on a database error, degrade
        // to the per-process bucket for this request instead of failing it.
        logger?.warn("durable rate limit unavailable — falling back to in-memory", {
          error: err instanceof Error ? err.message : String(err),
        });
        return handleInMemory(c, next, bucketKey, maxTokens, refillIntervalMs);
      }

      // Reset = seconds until this window ends (the draft header is a delta).
      const resetSeconds = Math.max(1, Math.ceil((windowStartMs + refillIntervalMs - now) / 1000));
      c.header("X-RateLimit-Reset", resetSeconds.toString());

      if (count > maxTokens) {
        c.header("X-RateLimit-Remaining", "0");
        return errorJson(c, 429, "RATE_LIMITED", "too many requests");
      }
      c.header("X-RateLimit-Remaining", (maxTokens - count).toString());
      await next();
      return;
    }

    return handleInMemory(c, next, bucketKey, maxTokens, refillIntervalMs);
  };

  // Shared by the no-db configuration and the db-error fallback so the two
  // cannot drift.
  async function handleInMemory(
    c: Parameters<MiddlewareHandler>[0],
    next: Parameters<MiddlewareHandler>[1],
    bucketKey: string,
    max: number,
    intervalMs: number,
  ): Promise<Response | undefined> {
    c.header("X-RateLimit-Reset", Math.ceil(intervalMs / 1000).toString());
    const remaining = consumeInMemory(bucketKey, max, intervalMs);
    if (remaining < 0) {
      c.header("X-RateLimit-Remaining", "0");
      return errorJson(c, 429, "RATE_LIMITED", "too many requests");
    }
    c.header("X-RateLimit-Remaining", remaining.toString());
    await next();
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Test helper — reset all in-memory buckets (used in tests only)
// ---------------------------------------------------------------------------

export function resetAllBuckets(): void {
  buckets.clear();
}
