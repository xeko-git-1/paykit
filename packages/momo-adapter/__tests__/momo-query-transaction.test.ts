/**
 * queryTransaction — Momo /v2/gateway/api/query, the per-reference lookup the
 * reconciler uses because Momo has no merchant-wide date-range listing.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMomoAdapter } from "../src/adapter.js";

const baseConfig = {
  partnerCode: "PARTNER1",
  accessKey: "access-1",
  secretKey: "secret-1",
  returnUrl: "https://shop.example/return",
  ipnUrl: "https://shop.example/ipn",
};

function fetchReturning(json: Record<string, unknown>, ok = true, status = 200) {
  const mock = vi.fn().mockResolvedValue({ ok, status, json: async () => json });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe("createMomoAdapter — queryTransaction", () => {
  it("declares canListTransactions=false so the reconciler uses the per-row path", () => {
    const adapter = createMomoAdapter(baseConfig);
    expect(adapter.canListTransactions).toBe(false);
    expect(typeof adapter.queryTransaction).toBe("function");
  });

  it("signs accessKey/orderId/partnerCode/requestId and posts to the query endpoint", async () => {
    const mock = fetchReturning({ resultCode: 0, amount: 50_000 });
    const adapter = createMomoAdapter(baseConfig);
    await adapter.queryTransaction?.({ providerRef: "order-1" });

    expect(mock.mock.calls[0]?.[0]).toContain("/v2/gateway/api/query");
    const body = JSON.parse(mock.mock.calls[0]?.[1]?.body as string) as Record<string, string>;
    const expected = createHmac("sha256", "secret-1")
      .update(
        `accessKey=access-1&orderId=order-1&partnerCode=PARTNER1&requestId=${body.requestId}`,
        "utf-8",
      )
      .digest("hex");
    expect(body.signature).toBe(expected);
    expect(body.orderId).toBe("order-1");
  });

  it("maps resultCode 0 to a settled VND record", async () => {
    fetchReturning({ resultCode: 0, amount: 50_000, transId: 12345 });
    const adapter = createMomoAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "order-1" })).toEqual({
      status: "settled",
      record: {
        providerRef: "order-1",
        amountMicros: (50_000n * 1_000_000n).toString(),
        currencyCode: "VND",
      },
    });
  });

  it.each([1000, 7000, 7002, 9000])("maps in-flight resultCode %i to pending", async (code) => {
    fetchReturning({ resultCode: code });
    const adapter = createMomoAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "order-1" })).toEqual({
      status: "pending",
    });
  });

  it.each([42, 1001, 1005, 1006])(
    "maps declined/expired/unknown-order resultCode %i to not_found",
    async (code) => {
      fetchReturning({ resultCode: code });
      const adapter = createMomoAdapter(baseConfig);
      expect(await adapter.queryTransaction?.({ providerRef: "order-1" })).toEqual({
        status: "not_found",
      });
    },
  );

  it("throws on auth/system errors — an unanswered question is not an absence", async () => {
    fetchReturning({ resultCode: 13, message: "Merchant authentication failed" });
    const adapter = createMomoAdapter(baseConfig);
    await expect(adapter.queryTransaction?.({ providerRef: "order-1" })).rejects.toThrow(
      "Momo query failed: 13",
    );
  });

  it("throws on HTTP failure instead of mapping it to not_found", async () => {
    fetchReturning({}, false, 502);
    const adapter = createMomoAdapter(baseConfig);
    await expect(adapter.queryTransaction?.({ providerRef: "order-1" })).rejects.toThrow(
      "HTTP 502",
    );
  });
});
