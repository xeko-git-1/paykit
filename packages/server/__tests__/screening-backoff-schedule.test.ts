/**
 * Retry schedule for inconclusive screenings.
 *
 * The properties under test are the ones that keep a screening-provider outage
 * from turning into a self-inflicted retry storm: the delay grows, it is capped so
 * a job does not park for hours, it is never zero (which would busy-loop the
 * queue), and it is jittered so a batch of jobs that all failed in the same
 * instant do not all retry in the same instant.
 *
 * `random` is injected rather than stubbed globally, and no test sleeps — the
 * schedule is a pure function of (attempts, random).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SCREENING_ATTEMPTS,
  screeningAttemptsExhausted,
  screeningRetryDelayMs,
} from "../src/services/screening-backoff.js";

/** Ceiling for a given attempt count, probed by pinning full jitter to its max. */
function ceilingFor(attempts: number): number {
  return screeningRetryDelayMs(attempts, () => 1);
}

describe("screeningRetryDelayMs", () => {
  it("grows exponentially across attempts", () => {
    const ceilings = [1, 2, 3, 4].map(ceilingFor);
    ceilings.reduce((previous, current) => {
      expect(current).toBeGreaterThan(previous);
      return current;
    });
  });

  it("doubles per attempt while below the cap", () => {
    expect(ceilingFor(2)).toBe(ceilingFor(1) * 2);
    expect(ceilingFor(3)).toBe(ceilingFor(1) * 4);
  });

  it("caps the ceiling so a job never parks for hours", () => {
    const FIFTEEN_MINUTES_MS = 15 * 60_000;
    // Far beyond the attempt cap, to prove the bound is on the value and not
    // merely on how many attempts are allowed.
    expect(ceilingFor(50)).toBe(FIFTEEN_MINUTES_MS);
    expect(ceilingFor(MAX_SCREENING_ATTEMPTS)).toBeLessThanOrEqual(FIFTEEN_MINUTES_MS);
  });

  it("never returns zero, even when the jitter draw is zero", () => {
    // A zero delay makes the job immediately due again, which spins the queue
    // against a provider that is already failing.
    for (const attempts of [0, 1, 2, 5, 20]) {
      expect(screeningRetryDelayMs(attempts, () => 0)).toBeGreaterThanOrEqual(1);
    }
  });

  it("applies full jitter: the same attempt count yields different delays", () => {
    // The point of jitter is that a synchronized batch de-synchronizes. Distinct
    // draws must produce distinct delays rather than a fixed schedule.
    const low = screeningRetryDelayMs(4, () => 0.1);
    const high = screeningRetryDelayMs(4, () => 0.9);
    expect(low).not.toBe(high);
    expect(low).toBeLessThan(high);
  });

  it("keeps every jittered delay within (0, ceiling]", () => {
    const attempts = 4;
    const ceiling = ceilingFor(attempts);
    for (const draw of [0, 0.01, 0.25, 0.5, 0.75, 1]) {
      const delay = screeningRetryDelayMs(attempts, () => draw);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("treats attempt 0 and attempt 1 as the same base delay", () => {
    // A job is read after its attempt counter was incremented, so 1 is the first
    // value seen in practice; 0 must not compute a negative exponent.
    expect(ceilingFor(0)).toBe(ceilingFor(1));
  });
});

describe("screeningAttemptsExhausted", () => {
  it("allows retries below the cap", () => {
    for (let attempts = 0; attempts < MAX_SCREENING_ATTEMPTS; attempts++) {
      expect(screeningAttemptsExhausted(attempts)).toBe(false);
    }
  });

  it("stops retrying at and above the cap", () => {
    expect(screeningAttemptsExhausted(MAX_SCREENING_ATTEMPTS)).toBe(true);
    expect(screeningAttemptsExhausted(MAX_SCREENING_ATTEMPTS + 5)).toBe(true);
  });

  it("bounds the retry budget to a finite number of attempts", () => {
    // Guards against the cap being raised to something that effectively retries
    // forever, which would leave a payment uncredited indefinitely instead of
    // escalating it to a human.
    expect(MAX_SCREENING_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_SCREENING_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
