import { describe, expect, it, vi } from "vitest";
import { createSepayFetcher } from "../src/reconcile/sepay-fetcher.js";

describe("createSepayFetcher", () => {
  it("converts SePay VND amount → micros (× 1_000_000)", async () => {
    const pull = vi.fn(async () => [
      { id: "evt-1", orderId: "order-A", transferAmount: 100_000 },
      { id: "evt-2", orderId: "order-B", transferAmount: 250_000 },
    ]);
    const fetcher = createSepayFetcher(pull);
    const records = await fetcher.list({ since: new Date(), until: new Date() });
    expect(records).toHaveLength(2);
    expect(records[0]?.providerRef).toBe("order-A");
    expect(records[0]?.amountMicros).toBe("100000000000"); // 100_000 × 1_000_000
    expect(records[0]?.currencyCode).toBe("VND");
    expect(records[1]?.amountMicros).toBe("250000000000");
  });

  it("forwards window arg to underlying pull function", async () => {
    const pull = vi.fn(async () => []);
    const fetcher = createSepayFetcher(pull);
    const since = new Date("2026-05-22T00:00:00Z");
    const until = new Date("2026-05-23T00:00:00Z");
    await fetcher.list({ since, until });
    expect(pull).toHaveBeenCalledWith({ since, until });
  });

  it("empty pull → empty array", async () => {
    const fetcher = createSepayFetcher(async () => []);
    const records = await fetcher.list({ since: new Date() });
    expect(records).toEqual([]);
  });
});
