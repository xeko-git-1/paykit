/**
 * Retry schedule for inconclusive screenings.
 *
 * Jitter is not cosmetic here: a screening provider outage makes every queued
 * job fail at once, and a fixed schedule would then retry them all in the same
 * instant, repeatedly — the retry storm keeps the provider down. The random
 * component spreads a synchronized batch back out.
 */

/** Cap on attempts before a job stops retrying and goes to human review. */
export const MAX_SCREENING_ATTEMPTS = 6;

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60_000;

/**
 * Exponential backoff with full jitter, for a job that has already recorded
 * `attempts` attempts.
 *
 * `random` is injectable so a test can assert the schedule deterministically
 * instead of sleeping or accepting a range.
 */
export function screeningRetryDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1);
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  // Full jitter: anywhere in (0, ceiling]. Keeps a lower bound of 1ms so a
  // delay is never zero, which would busy-loop the queue.
  return Math.max(1, Math.round(ceiling * random()));
}

/** Whether an inconclusive job has any attempts left. */
export function screeningAttemptsExhausted(attempts: number): boolean {
  return attempts >= MAX_SCREENING_ATTEMPTS;
}
