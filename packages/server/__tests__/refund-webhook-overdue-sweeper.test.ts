/**
 * The overdue-refund sweeper: a pending_webhook refund that never hears back
 * must become someone's problem on purpose.
 *
 * What is pinned here:
 *   - the cutoff is now − timeout (24h default, configurable)
 *   - every row marked by a sweep raises the counter once, labelled by provider
 *   - the log names the transaction and points at the runbook
 *   - a sweep that finds nothing emits nothing
 *   - money state is never touched — the sweeper only calls the marking repo
 *
 * The repo is mocked: exactly-once marking under concurrency is the repo's
 * guarded-UPDATE contract, tested at the SQL layer; this file tests what the
 * sweeper does with the rows the repo hands back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const markMock = vi.hoisted(() => vi.fn());

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/refund-overdue.repo.js", () => ({
  REFUND_WEBHOOK_OVERDUE_KEY: "refund_webhook_overdue_at",
  markOverdueRefundWebhooks: markMock,
  listOverdueRefundWebhooks: vi.fn(),
}));

import {
  REFUND_WEBHOOK_TIMEOUT_MS,
  sweepOverdueRefundWebhooks,
} from "../src/services/refund-webhook-overdue-sweeper.js";

const NOW = new Date("2026-08-13T12:00:00Z");

function overdueRow(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "10000000-0000-4000-8000-000000000001",
    tenantId: "20000000-0000-4000-8000-000000000002",
    provider: "nowpayments",
    amountMicros: "5000000",
    currencyCode: "USD",
    status: "refund_pending_webhook",
    updatedAt: new Date("2026-08-11T12:00:00Z"),
    metadataJson: {},
    ...overrides,
  };
}

beforeEach(() => {
  markMock.mockReset();
  markMock.mockResolvedValue([]);
});

describe("sweepOverdueRefundWebhooks", () => {
  it("asks the repo for rows older than now minus the 24h default", async () => {
    await sweepOverdueRefundWebhooks({ db: {} as never, now: () => NOW });

    expect(markMock).toHaveBeenCalledTimes(1);
    const opts = markMock.mock.calls[0]?.[1] as { cutoff: Date; now: Date };
    expect(opts.now).toEqual(NOW);
    expect(opts.cutoff).toEqual(new Date(NOW.getTime() - REFUND_WEBHOOK_TIMEOUT_MS));
    expect(REFUND_WEBHOOK_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("honours a configured timeout", async () => {
    await sweepOverdueRefundWebhooks(
      { db: {} as never, now: () => NOW },
      { timeoutMs: 60 * 60 * 1000 },
    );

    const opts = markMock.mock.calls[0]?.[1] as { cutoff: Date };
    expect(opts.cutoff).toEqual(new Date(NOW.getTime() - 60 * 60 * 1000));
  });

  it("raises the counter once per marked row, labelled by provider", async () => {
    markMock.mockResolvedValue([
      overdueRow({ provider: "nowpayments" }),
      overdueRow({
        transactionId: "10000000-0000-4000-8000-000000000003",
        provider: "bitpay",
      }),
    ]);
    const emitMetric = vi.fn();

    const marked = await sweepOverdueRefundWebhooks({
      db: {} as never,
      emitMetric,
      now: () => NOW,
    });

    expect(marked).toHaveLength(2);
    expect(emitMetric).toHaveBeenCalledTimes(2);
    expect(emitMetric).toHaveBeenCalledWith("paykit_refund_webhook_overdue_total", {
      provider: "nowpayments",
    });
    expect(emitMetric).toHaveBeenCalledWith("paykit_refund_webhook_overdue_total", {
      provider: "bitpay",
    });
  });

  it("logs each overdue refund with the transaction and the runbook pointer", async () => {
    markMock.mockResolvedValue([overdueRow()]);
    const warn = vi.fn();

    await sweepOverdueRefundWebhooks({ db: {} as never, logger: { warn }, now: () => NOW });

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, details] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("docs/refund-flows.md");
    expect(details).toMatchObject({
      transactionId: "10000000-0000-4000-8000-000000000001",
      provider: "nowpayments",
      amountMicros: "5000000",
    });
  });

  it("emits nothing when nothing is overdue — the normal steady state", async () => {
    const emitMetric = vi.fn();
    const warn = vi.fn();

    const marked = await sweepOverdueRefundWebhooks({
      db: {} as never,
      emitMetric,
      logger: { warn },
      now: () => NOW,
    });

    expect(marked).toEqual([]);
    expect(emitMetric).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes the batch bound through to the repo", async () => {
    await sweepOverdueRefundWebhooks({ db: {} as never, now: () => NOW }, { limit: 5 });

    const opts = markMock.mock.calls[0]?.[1] as { limit?: number };
    expect(opts.limit).toBe(5);
  });
});
