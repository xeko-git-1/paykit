/**
 * The tick the durable queues depend on.
 *
 * An unmatched webhook and an inconclusive screening are both waiting on something
 * to come back for them. If this loop stops — or never starts — a paid customer is
 * never credited and nothing raises an error, which is exactly the failure the inbox
 * was built to remove. So the properties worth pinning are not "it drains" but the
 * ways it could quietly stop draining:
 *
 *   - a thrown error must not kill the interval,
 *   - a slow tick must not stack another on top of itself,
 *   - stopping must actually stop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  drainWebhookInbox: vi.fn(),
  drainScreeningJobs: vi.fn(),
  sweepWebhookInbox: vi.fn(),
}));

vi.mock("@vibecc/paykit-server", () => server);

import { startBackgroundDrains } from "../src/background-drains.js";

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  server.drainWebhookInbox.mockResolvedValue([]);
  server.drainScreeningJobs.mockResolvedValue([]);
  server.sweepWebhookInbox.mockResolvedValue(0);
});

describe("one tick", () => {
  it("drains the webhook inbox", async () => {
    const drains = startBackgroundDrains({ db }, { intervalMs: 0 });
    await drains.tick();

    expect(server.drainWebhookInbox).toHaveBeenCalledTimes(1);
  });

  it("does not run the screening drain when no screening service is configured", async () => {
    // Draining a queue nothing enqueues into is a pointless query every tick.
    const drains = startBackgroundDrains({ db }, { intervalMs: 0 });
    await drains.tick();

    expect(server.drainScreeningJobs).not.toHaveBeenCalled();
  });

  it("drains screening jobs when a screening service is configured", async () => {
    const drains = startBackgroundDrains(
      { db, screeningService: { screen: async () => ({ decision: "clear" }) } as never },
      { intervalMs: 0 },
    );
    await drains.tick();

    expect(server.drainScreeningJobs).toHaveBeenCalledTimes(1);
  });

  it("tells the processor that credits are deferred when screening is configured", async () => {
    const drains = startBackgroundDrains(
      { db, screeningService: { screen: async () => ({ decision: "clear" }) } as never },
      { intervalMs: 0 },
    );
    await drains.tick();

    const [deps] = server.drainWebhookInbox.mock.calls[0] as [Record<string, unknown>];
    // Getting this wrong would credit inline a payment that is supposed to wait for
    // a compliance verdict.
    expect(deps.screeningConfigured).toBe(true);
  });

  it("bounds how much one tick processes", async () => {
    const drains = startBackgroundDrains({ db }, { intervalMs: 0, maxPerTick: 7 });
    await drains.tick();

    expect(server.drainWebhookInbox).toHaveBeenCalledWith(expect.anything(), 7);
  });
});

describe("failure containment", () => {
  it("survives a drain that throws", async () => {
    server.drainWebhookInbox.mockRejectedValue(new Error("connection reset"));
    const warn = vi.fn();
    const drains = startBackgroundDrains({ db, logger: { warn } }, { intervalMs: 0 });

    // One transient database error must not end all background processing for the
    // life of the process — and it must say so, because a silently stopped drain
    // looks identical to an empty queue.
    await expect(drains.tick()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("keeps ticking after a failure", async () => {
    server.drainWebhookInbox.mockRejectedValueOnce(new Error("blip"));
    const drains = startBackgroundDrains({ db }, { intervalMs: 0 });

    await drains.tick();
    await drains.tick();

    expect(server.drainWebhookInbox).toHaveBeenCalledTimes(2);
  });

  it("does not stack a second tick on top of a slow one", async () => {
    let release: (() => void) | undefined;
    server.drainWebhookInbox.mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const drains = startBackgroundDrains({ db }, { intervalMs: 0 });

    const first = drains.tick();
    // Overlapping drains would claim different rows — safe, thanks to the guarded
    // UPDATE — but double the connection demand exactly when the database is slow.
    await drains.tick();
    expect(server.drainWebhookInbox).toHaveBeenCalledTimes(1);

    release?.();
    await first;
  });
});

describe("the retention sweep", () => {
  it("does not run on every tick", async () => {
    const drains = startBackgroundDrains({ db }, { intervalMs: 0, sweepEveryTicks: 3 });
    await drains.tick();
    await drains.tick();

    expect(server.sweepWebhookInbox).not.toHaveBeenCalled();
  });

  it("runs once the tick count comes round", async () => {
    const drains = startBackgroundDrains({ db }, { intervalMs: 0, sweepEveryTicks: 3 });
    await drains.tick();
    await drains.tick();
    await drains.tick();

    expect(server.sweepWebhookInbox).toHaveBeenCalledTimes(1);
  });

  it("can be disabled", async () => {
    const drains = startBackgroundDrains({ db }, { intervalMs: 0, sweepEveryTicks: 0 });
    await drains.tick();

    expect(server.sweepWebhookInbox).not.toHaveBeenCalled();
  });
});

describe("the loop", () => {
  it("does not schedule anything when the interval is zero", () => {
    // The escape hatch for an operator running an external scheduler.
    const spy = vi.spyOn(globalThis, "setInterval");
    const drains = startBackgroundDrains({ db }, { intervalMs: 0 });

    expect(spy).not.toHaveBeenCalled();
    drains.stop();
    spy.mockRestore();
  });

  it("ticks on the interval and stops when told", async () => {
    vi.useFakeTimers();
    try {
      const drains = startBackgroundDrains({ db }, { intervalMs: 1_000 });

      await vi.advanceTimersByTimeAsync(2_500);
      expect(server.drainWebhookInbox).toHaveBeenCalledTimes(2);

      drains.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      // A loop that kept running after stop() would query a closed pool during
      // shutdown and log errors that describe nothing but the shutdown.
      expect(server.drainWebhookInbox).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
