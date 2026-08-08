/**
 * Exponential backoff with full jitter — the retry schedule for any queue whose
 * work depends on something outside this process.
 *
 * Jitter is the load-bearing part, not a refinement. An outage in a dependency
 * makes every queued item fail at nearly the same moment; a deterministic
 * schedule then retries that whole batch in the same instant, again and again,
 * and the synchronized retries are what keep the dependency down. The random
 * component spreads a batch that failed together back out over time.
 *
 * The schedule lives here, in one place, because two queues already need it —
 * compliance screening and the webhook inbox — and a second copy would drift:
 * the one that got tuned would be the one nobody was looking at.
 */

export interface BackoffOptions {
  /** Attempts already recorded, including the one that just failed. */
  readonly attempts: number;
  /** Delay ceiling for the first retry. */
  readonly baseDelayMs: number;
  /** Cap, so the ceiling stops doubling instead of growing without bound. */
  readonly maxDelayMs: number;
  /** Injectable so a test can assert an exact schedule rather than a range. */
  readonly random?: () => number;
}

/**
 * Delay before the next attempt, in milliseconds.
 *
 * The result is uniform in (0, ceiling] where ceiling doubles per attempt up to
 * `maxDelayMs` — "full jitter". A floor of 1ms keeps a delay from ever being
 * zero, which would turn the queue into a busy loop.
 */
export function backoffDelayMs(opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const exponent = Math.max(0, opts.attempts - 1);
  const ceiling = Math.min(opts.baseDelayMs * 2 ** exponent, opts.maxDelayMs);
  return Math.max(1, Math.round(ceiling * random()));
}

/** The wall-clock instant of the next attempt, for a `next_retry_at` column. */
export function nextAttemptAt(opts: BackoffOptions & { now?: Date }): Date {
  const now = opts.now ?? new Date();
  return new Date(now.getTime() + backoffDelayMs(opts));
}
