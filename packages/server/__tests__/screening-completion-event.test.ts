/**
 * `payment.completed` must still reach consumers when screening is configured.
 *
 * Before the screening call moved out of the crediting transaction, the webhook
 * credited the payment inline and emitted the event itself. Now the webhook only
 * parks the payment, so there is nothing to announce at that point — the event has
 * to be emitted by whoever applies the verdict. Without that, a tenant whose
 * consumer fulfils orders on `payment.completed` silently stops fulfilling them
 * the moment they configure screening: the money moves, the order never ships.
 *
 * The second invariant here is that a duplicated verdict emits nothing. The credit
 * is a no-op when another attempt already won the status transition, so the event
 * has to be a no-op too — a consumer that fulfils an order on the event would
 * otherwise fulfil it twice for one payment.
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
vi.mock("@vibecc/paykit-auth-core/db/repos/payment.repo.js", () => ({
  findByProviderRef: vi.fn(),
}));
vi.mock("../src/services/screening-verdict-tx.js", () => ({
  creditScreenedPayment: vi.fn(),
  quarantineScreenedPayment: vi.fn(),
}));

import { findByProviderRef } from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import { claimNextScreeningJob } from "@vibecc/paykit-auth-core/db/repos/screening-job.repo.js";
import { processNextScreeningJob } from "../src/services/screening-runner.js";
import {
  creditScreenedPayment,
  quarantineScreenedPayment,
} from "../src/services/screening-verdict-tx.js";

const mClaim = claimNextScreeningJob as ReturnType<typeof vi.fn>;
const mFindByRef = findByProviderRef as ReturnType<typeof vi.fn>;
const mCredit = creditScreenedPayment as ReturnType<typeof vi.fn>;
const mQuarantine = quarantineScreenedPayment as ReturnType<typeof vi.fn>;

const TX_ID = "a0000000-0000-4000-8000-000000000001";
const db = {} as never;

const paymentRow = {
  transactionId: TX_ID,
  tenantId: "tenant-1",
  ownerId: "owner-1",
  provider: "sepay",
  providerRef: "prov-ref-1",
  amountMicros: "750000000",
  currencyCode: "VND",
  status: "completed",
};

function job() {
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
  };
}

beforeEach(() => {
  mClaim.mockReset().mockResolvedValue(job());
  mFindByRef.mockReset().mockResolvedValue(paymentRow);
  mCredit.mockReset().mockResolvedValue({ applied: true });
  mQuarantine.mockReset().mockResolvedValue({ applied: true });
});

describe("payment.completed after a cleared screening", () => {
  it("emits payment.completed with the credited payment row", async () => {
    const onPaymentCompleted = vi.fn();
    await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
      events: { onPaymentCompleted },
    });
    expect(onPaymentCompleted).toHaveBeenCalledTimes(1);
    expect(onPaymentCompleted).toHaveBeenCalledWith(paymentRow);
  });

  it("looks the payment up by the same (provider, ref) pair the job carries", async () => {
    await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
      events: { onPaymentCompleted: vi.fn() },
    });
    expect(mFindByRef).toHaveBeenCalledWith(db, "sepay", "prov-ref-1");
  });

  it("emits nothing when the verdict was already applied by another attempt", async () => {
    // A lease that expired mid-call, or a redelivery: the credit is a no-op, so
    // the event has to be one too.
    mCredit.mockResolvedValue({ applied: false });
    const onPaymentCompleted = vi.fn();
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
      events: { onPaymentCompleted },
    });
    expect(onPaymentCompleted).not.toHaveBeenCalled();
    // Still reported as credited: the payment IS credited, just not by this call.
    expect(outcome).toEqual({ result: "credited", transactionId: TX_ID });
  });

  it("does not read the payment row at all when no handlers are configured", async () => {
    await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
    });
    expect(mFindByRef).not.toHaveBeenCalled();
  });

  it("a handler that throws does not fail the job — the money already moved", async () => {
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
      events: {
        onPaymentCompleted: () => {
          throw new Error("consumer blew up");
        },
      },
    });
    expect(outcome).toEqual({ result: "credited", transactionId: TX_ID });
  });

  it("survives the payment row having vanished between credit and lookup", async () => {
    mFindByRef.mockResolvedValue(undefined);
    const onPaymentCompleted = vi.fn();
    const outcome = await processNextScreeningJob({
      db,
      screeningService: async () => ({ verdict: "clear" }),
      events: { onPaymentCompleted },
    });
    expect(onPaymentCompleted).not.toHaveBeenCalled();
    expect(outcome).toEqual({ result: "credited", transactionId: TX_ID });
  });
});

describe("no completion event on a blocked screening", () => {
  for (const verdict of ["reject", "manual_review"] as const) {
    it(`emits nothing when screening returns ${verdict}`, async () => {
      const onPaymentCompleted = vi.fn();
      await processNextScreeningJob({
        db,
        screeningService: async () => ({ verdict, reason: "sanctioned" }),
        events: { onPaymentCompleted },
      });
      expect(onPaymentCompleted).not.toHaveBeenCalled();
      expect(mCredit).not.toHaveBeenCalled();
    });
  }

  it("emits nothing when the screening service gives no answer", async () => {
    const onPaymentCompleted = vi.fn();
    await processNextScreeningJob({
      db,
      screeningService: async () => {
        throw new Error("upstream down");
      },
      events: { onPaymentCompleted },
    });
    expect(onPaymentCompleted).not.toHaveBeenCalled();
    expect(mCredit).not.toHaveBeenCalled();
  });
});
