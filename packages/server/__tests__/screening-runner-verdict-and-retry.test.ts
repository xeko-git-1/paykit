/**
 * Screening runner — verdict routing, and what happens when no verdict arrives.
 *
 * The invariant that matters most here is negative: an absent answer must never
 * read as permission. A screening service that times out, 5xxes, or returns
 * garbage means paykit does not know whether the payment may be credited, so the
 * payment stays uncredited and the job is retried. Mapping a failed call to
 * "clear" is precisely how a sanctioned payment gets credited during an outage,
 * so every failure path below asserts that no credit happened.
 *
 * The runner is also the only thing standing between a permanently-unanswerable
 * screening and an infinite retry loop, so attempt exhaustion is asserted to end
 * in a human queue rather than in either a retry or a credit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vibecc/paykit-auth-core/db/repos/balance.repo.js", () => ({ applyDelta: vi.fn() }));
vi.mock("@vibecc/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/discount.repo.js", () => ({
  commitReservation: vi.fn(),
  releaseReservation: vi.fn(),
}));
vi.mock("@vibecc/paykit-auth-core/db/repos/screening-job.repo.js", () => ({
  claimNextScreeningJob: vi.fn(),
  markScreeningDecided: vi.fn(),
  markScreeningRetryable: vi.fn(),
}));
// The verdict transactions have their own tests; here they are observed, so the
// runner's routing decision is asserted without a database.
vi.mock("../src/services/screening-verdict-tx.js", () => ({
  creditScreenedPayment: vi.fn(),
  quarantineScreenedPayment: vi.fn(),
}));

import {
  claimNextScreeningJob,
  markScreeningRetryable,
} from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
import { MAX_SCREENING_ATTEMPTS } from "../src/services/screening-backoff.js";
import { drainScreeningJobs, processNextScreeningJob } from "../src/services/screening-runner.js";
import {
  creditScreenedPayment,
  quarantineScreenedPayment,
} from "../src/services/screening-verdict-tx.js";

const mClaim = claimNextScreeningJob as ReturnType<typeof vi.fn>;
const mRetryable = markScreeningRetryable as ReturnType<typeof vi.fn>;
const mCredit = creditScreenedPayment as ReturnType<typeof vi.fn>;
const mQuarantine = quarantineScreenedPayment as ReturnType<typeof vi.fn>;

const TX_ID = "a0000000-0000-4000-8000-000000000001";
const db = {} as never;

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "b0000000-0000-4000-8000-000000000009",
    transactionId: TX_ID,
    tenantId: "tenant-1",
    ownerId: "owner-1",
    provider: "sepay",
    sourceId: "prov-ref-1",
    creditMicros: "750000000",
    currencyCode: "VND",
    eventJson: { type: "payment.completed" },
    state: "in_progress",
    attempts: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mClaim.mockReset();
  mRetryable.mockReset().mockResolvedValue(undefined);
  mCredit.mockReset().mockResolvedValue({ applied: true });
  mQuarantine.mockReset().mockResolvedValue({ applied: true });
});

describe("screening runner — verdict routing", () => {
  it("is idle when nothing is due, so a caller can back off instead of spinning", async () => {
    mClaim.mockResolvedValue(undefined);
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
    });
    expect(outcome).toEqual({ result: "idle" });
    expect(mCredit).not.toHaveBeenCalled();
    expect(mQuarantine).not.toHaveBeenCalled();
  });

  it("credits on a clear verdict", async () => {
    mClaim.mockResolvedValue(job());
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
    });
    expect(outcome).toEqual({ result: "credited", transactionId: TX_ID });
    expect(mCredit).toHaveBeenCalledTimes(1);
    expect(mQuarantine).not.toHaveBeenCalled();
  });

  it("passes the screening service the amount frozen on the job, not a re-derived one", async () => {
    mClaim.mockResolvedValue(job({ creditMicros: "750000000", currencyCode: "VND" }));
    const seen: Record<string, unknown>[] = [];
    await processNextScreeningJob({
      db,
      screeningService: async (req) => {
        seen.push({ ...req });
        return { verdict: "clear" };
      },
    });
    expect(seen[0]).toMatchObject({
      transactionId: TX_ID,
      tenantId: "tenant-1",
      provider: "sepay",
      amountMicros: "750000000",
      currencyCode: "VND",
    });
  });

  it("quarantines as rejected on a reject verdict, without crediting", async () => {
    mClaim.mockResolvedValue(job());
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "reject", reason: "sanctioned wallet" }),
    });
    expect(outcome).toEqual({
      result: "quarantined",
      transactionId: TX_ID,
      reason: "sanctioned wallet",
    });
    expect(mCredit).not.toHaveBeenCalled();
    expect(mQuarantine).toHaveBeenCalledTimes(1);
    expect(mQuarantine.mock.calls[0]?.[2]).toMatchObject({ state: "rejected" });
  });

  it("quarantines as manual_review on a manual_review verdict, without crediting", async () => {
    mClaim.mockResolvedValue(job());
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "manual_review", reason: "name match" }),
    });
    expect(outcome).toMatchObject({ result: "manual_review", transactionId: TX_ID });
    expect(mCredit).not.toHaveBeenCalled();
    expect(mQuarantine.mock.calls[0]?.[2]).toMatchObject({ state: "manual_review" });
  });
});

describe("screening runner — an absent answer is not permission", () => {
  it("schedules a retry and does not credit when the service throws", async () => {
    mClaim.mockResolvedValue(job({ attempts: 1 }));
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => {
        throw new Error("upstream 503");
      },
      random: () => 0.5,
    });
    expect(outcome.result).toBe("retry_scheduled");
    expect(mCredit).not.toHaveBeenCalled();
    expect(mQuarantine).not.toHaveBeenCalled();
    expect(mRetryable).toHaveBeenCalledTimes(1);
  });

  it("records the failure on the job so an operator can see why it stalled", async () => {
    mClaim.mockResolvedValue(job({ attempts: 1 }));
    await processNextScreeningJob({
      db,
      screeningService: async () => {
        throw new Error("upstream 503");
      },
      random: () => 0.5,
    });
    expect(mRetryable.mock.calls[0]?.[1]).toMatchObject({
      errorCode: "SCREENING_CALL_FAILED",
      errorMessage: "upstream 503",
    });
  });

  it("treats a service that never answers as retryable rather than waiting on it", async () => {
    mClaim.mockResolvedValue(job({ attempts: 1 }));
    const outcome = await processNextScreeningJob({
      db,
      // Never resolves: only the runner's own timeout can end this call.
      screeningService: () => new Promise(() => {}),
      callTimeoutMs: 10,
      random: () => 0.5,
    });
    expect(outcome.result).toBe("retry_scheduled");
    expect(mCredit).not.toHaveBeenCalled();
    expect(mRetryable.mock.calls[0]?.[1]).toMatchObject({
      errorCode: "SCREENING_UNAVAILABLE",
    });
  });

  it("schedules the retry in the future", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    mClaim.mockResolvedValue(job({ attempts: 1 }));
    await processNextScreeningJob({
      db,
      screeningService: async () => {
        throw new Error("upstream 503");
      },
      random: () => 1,
      now: () => now,
    });
    const scheduled = mRetryable.mock.calls[0]?.[1] as { nextAttemptAt: Date };
    expect(scheduled.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("sends an unanswerable screening to human review instead of retrying forever", async () => {
    mClaim.mockResolvedValue(job({ attempts: MAX_SCREENING_ATTEMPTS }));
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => {
        throw new Error("upstream 503");
      },
    });
    expect(outcome.result).toBe("manual_review");
    // Exhaustion is not a licence to credit, and not another retry.
    expect(mCredit).not.toHaveBeenCalled();
    expect(mRetryable).not.toHaveBeenCalled();
    expect(mQuarantine.mock.calls[0]?.[2]).toMatchObject({ state: "manual_review" });
  });
});

describe("screening runner — drain", () => {
  it("stops as soon as the queue is idle", async () => {
    mClaim.mockResolvedValueOnce(job()).mockResolvedValueOnce(undefined);
    const outcomes = await drainScreeningJobs({
      db,
      screeningService: async () => ({ verdict: "clear" }),
    });
    expect(outcomes).toHaveLength(1);
    expect(mClaim).toHaveBeenCalledTimes(2);
  });

  it("is bounded, so a queue refilled as fast as it drains cannot hold the caller", async () => {
    mClaim.mockResolvedValue(job());
    const outcomes = await drainScreeningJobs(
      { db, screeningService: async () => ({ verdict: "clear" }) },
      3,
    );
    expect(outcomes).toHaveLength(3);
    expect(mClaim).toHaveBeenCalledTimes(3);
  });
});
