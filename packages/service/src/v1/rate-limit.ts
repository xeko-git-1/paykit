import { errorJson } from "@xeko-git-1/paykit-server";
/**
 * In-memory token-bucket rate limiter keyed by API key ID.
 *
 * This is a soft, per-process throttle — NOT authoritative when running
 * multiple instances behind a load balancer. For durable rate limiting,
 * a shared store (Redis) is required (deferred to future version).
 *
 * Each key_id gets an independent bucket. Headers follow the RateLimit
 * draft standard (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset).
 */
import type { MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Token bucket implementation
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  /** Maximum tokens (requests) per window. Default: 100 */
  readonly maxTokens?: number;
  /** Refill interval in milliseconds. Default: 60_000 (1 minute) */
  readonly refillIntervalMs?: number;
}

const DEFAULT_MAX_TOKENS = 100;
const DEFAULT_REFILL_INTERVAL_MS = 60_000;

// In-memory store — resets on process restart (intentional: soft throttle)
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

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function rateLimitMiddleware(config: RateLimitConfig = {}): MiddlewareHandler {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const refillIntervalMs = config.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS;

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

    const bucket = getBucket(bucketKey, maxTokens);
    refillBucket(bucket, maxTokens, refillIntervalMs);

    const resetSeconds = Math.ceil(refillIntervalMs / 1000);

    // Set rate-limit headers on all responses
    c.header("X-RateLimit-Limit", maxTokens.toString());
    c.header("X-RateLimit-Reset", resetSeconds.toString());

    if (bucket.tokens <= 0) {
      c.header("X-RateLimit-Remaining", "0");
      return errorJson(c, 429, "RATE_LIMITED", "too many requests");
    }

    bucket.tokens -= 1;
    c.header("X-RateLimit-Remaining", bucket.tokens.toString());

    await next();
  };
}

// ---------------------------------------------------------------------------
// Test helper — reset all buckets (used in tests only)
// ---------------------------------------------------------------------------

export function resetAllBuckets(): void {
  buckets.clear();
}
