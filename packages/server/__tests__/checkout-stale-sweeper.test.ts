/**
 * The stale-checkout sweeper: a checkout nobody paid must eventually stop
 * holding a discount reservation.
 *
 * What is pinned here:
 *   - the cutoff is now − TTL (48h default, configurable)
 *   - the status flip and the reservation release happen in ONE transaction —
 *     a crash between them would leak the reservation permanently
 *   - only rows carrying a discountId release anything
 *   - every expired row raises the counter once, labelled by provider
 *   - a sweep that finds nothing emits nothing
 *
 * The repo is mocked: winning the race against a completing webhook is the
 * repo's guarded-UPDATE contract, tested at the SQL layer; this file tests
 * what the sweeper does with the rows the repo hands back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const expireMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/checkout-stale.repo.js", () => ({
  STALE_CHECKOUT_STATUSES: ["pending", "provider_creating", "awaiting_payment"],
  expireStaleCheckouts: expireMock,
}));

vi.mock("@xeko-git-1/paykit-auth-core/db/repos/discount.repo.js", () => ({
  releaseReservation: releaseMock,
}));

import {
  CHECKOUT_STALE_TTL_MS,
  sweepStaleCheckouts,
} from "../src/services/checkout-stale-sweeper.js";

const NOW = new Date("2026-08-13T12:00:00Z");
const TX_SENTINEL = { isTx: true };

/** A db whose transaction() hands the callback a sentinel tx, so the test can
 * assert every repo call happened inside it. */
function makeDb() {
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX_SENTINEL)),
  } as never;
}

function staleRow(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "10000000-0000-4000-8000-000000000001",
    tenantId: "20000000-0000-4000-8000-000000000002",
    provider: "stripe",
    amountMicros: "5000000",
    currencyCode: "USD",
    status: "expired",
    metadataJson: {},
    createdAt: new Date("2026-08-10T12:00:00Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  expireMock.mockReset();
  expireMock.mockResolvedValue([]);
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(undefined);
});

describe("sweepStaleCheckouts", () => {
  it("asks the repo for rows older than now minus the 48h default", async () => {
    await sweepStaleCheckouts({ db: makeDb(), now: () => NOW });

    expect(expireMock).toHaveBeenCalledTimes(1);
    const opts = expireMock.mock.calls[0]?.[1] as { cutoff: Date };
    expect(opts.cutoff).toEqual(new Date(NOW.getTime() - CHECKOUT_STALE_TTL_MS));
    expect(CHECKOUT_STALE_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("honours a configured TTL", async () => {
    await sweepStaleCheckouts({ db: makeDb(), now: () => NOW }, { ttlMs: 6 * 60 * 60 * 1000 });

    const opts = expireMock.mock.calls[0]?.[1] as { cutoff: Date };
    expect(opts.cutoff).toEqual(new Date(NOW.getTime() - 6 * 60 * 60 * 1000));
  });

  it("releases the discount reservation inside the SAME transaction as the flip", async () => {
    expireMock.mockResolvedValue([
      staleRow({ metadataJson: { discountId: "disc-1", discountApplied: true } }),
    ]);
    const db = makeDb();

    await sweepStaleCheckouts({ db, now: () => NOW });

    // Both repo calls received the sentinel tx — not the outer db — so the two
    // writes commit or roll back together.
    expect(expireMock.mock.calls[0]?.[0]).toBe(TX_SENTINEL);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(TX_SENTINEL, "disc-1");
  });

  it("releases nothing for rows without a discountId", async () => {
    expireMock.mockResolvedValue([staleRow({ metadataJson: {} })]);

    await sweepStaleCheckouts({ db: makeDb(), now: () => NOW });

    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("raises the counter once per expired row, labelled by provider", async () => {
    expireMock.mockResolvedValue([
      staleRow({ provider: "stripe" }),
      staleRow({
        transactionId: "10000000-0000-4000-8000-000000000003",
        provider: "vnpay",
      }),
    ]);
    const emitMetric = vi.fn();

    const expired = await sweepStaleCheckouts({ db: makeDb(), emitMetric, now: () => NOW });

    expect(expired).toHaveLength(2);
    expect(emitMetric).toHaveBeenCalledTimes(2);
    expect(emitMetric).toHaveBeenCalledWith("paykit_checkout_stale_expired_total", {
      provider: "stripe",
    });
    expect(emitMetric).toHaveBeenCalledWith("paykit_checkout_stale_expired_total", {
      provider: "vnpay",
    });
  });

  it("logs each expired checkout with the transaction identity", async () => {
    expireMock.mockResolvedValue([staleRow()]);
    const warn = vi.fn();

    await sweepStaleCheckouts({ db: makeDb(), logger: { warn }, now: () => NOW });

    expect(warn).toHaveBeenCalledTimes(1);
    const [, details] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(details).toMatchObject({
      transactionId: "10000000-0000-4000-8000-000000000001",
      provider: "stripe",
      amountMicros: "5000000",
    });
  });

  it("emits nothing when nothing is stale — the normal steady state", async () => {
    const emitMetric = vi.fn();
    const warn = vi.fn();

    const expired = await sweepStaleCheckouts({
      db: makeDb(),
      emitMetric,
      logger: { warn },
      now: () => NOW,
    });

    expect(expired).toEqual([]);
    expect(emitMetric).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes the batch bound through to the repo", async () => {
    await sweepStaleCheckouts({ db: makeDb(), now: () => NOW }, { limit: 7 });

    const opts = expireMock.mock.calls[0]?.[1] as { limit?: number };
    expect(opts.limit).toBe(7);
  });
});
