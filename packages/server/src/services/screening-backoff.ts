/**
 * Retry schedule for inconclusive screenings.
 *
 * The jitter and the doubling live in `backoffDelayMs`, shared with the webhook
 * inbox; what belongs here is only what is specific to screening — how patient to
 * be with a compliance provider, and how many attempts pass before a payment
 * stops waiting for a machine and goes to a human.
 */
import { backoffDelayMs } from "@vibecc/paykit";

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
  return backoffDelayMs({
    attempts,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    random,
  });
}

/** Whether an inconclusive job has any attempts left. */
export function screeningAttemptsExhausted(attempts: number): boolean {
  return attempts >= MAX_SCREENING_ATTEMPTS;
}
