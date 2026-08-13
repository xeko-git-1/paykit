/**
 * queryTransaction — ZaloPay /v2/query, the per-reference lookup the
 * reconciler uses because ZaloPay has no merchant-wide date-range listing.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZaloPayAdapter } from "../src/adapter.js";

const baseConfig = {
  appId: "553",
  key1: "key1-secret",
  key2: "key2-secret",
  returnUrl: "https://shop.example/return",
  callbackUrl: "https://shop.example/callback",
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

describe("createZaloPayAdapter — queryTransaction", () => {
  it("declares canListTransactions=false so the reconciler uses the per-row path", () => {
    const adapter = createZaloPayAdapter(baseConfig);
    expect(adapter.canListTransactions).toBe(false);
    expect(typeof adapter.queryTransaction).toBe("function");
  });

  it("signs app_id|app_trans_id|key1 with key1 and posts to /v2/query", async () => {
    const mock = fetchReturning({ return_code: 1, amount: 75_000 });
    const adapter = createZaloPayAdapter(baseConfig);
    await adapter.queryTransaction?.({ providerRef: "260813_abc123" });

    expect(mock.mock.calls[0]?.[0]).toContain("/v2/query");
    const body = JSON.parse(mock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    const expected = createHmac("sha256", "key1-secret")
      .update("553|260813_abc123|key1-secret", "utf-8")
      .digest("hex");
    expect(body.mac).toBe(expected);
    expect(body.app_id).toBe(553);
    expect(body.app_trans_id).toBe("260813_abc123");
  });

  it("maps return_code 1 (SUCCESS) to a settled VND record", async () => {
    fetchReturning({ return_code: 1, amount: 75_000, zp_trans_id: 9988 });
    const adapter = createZaloPayAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "260813_abc123" })).toEqual({
      status: "settled",
      record: {
        providerRef: "260813_abc123",
        amountMicros: (75_000n * 1_000_000n).toString(),
        currencyCode: "VND",
      },
    });
  });

  it("maps return_code 3 (PROCESSING) to pending", async () => {
    fetchReturning({ return_code: 3 });
    const adapter = createZaloPayAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "260813_abc123" })).toEqual({
      status: "pending",
    });
  });

  it("maps return_code 2 (FAIL) to not_found — no settled money", async () => {
    fetchReturning({ return_code: 2 });
    const adapter = createZaloPayAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "260813_abc123" })).toEqual({
      status: "not_found",
    });
  });

  it("throws on unknown return codes — an unanswered question is not an absence", async () => {
    fetchReturning({ return_code: -401, return_message: "mac invalid" });
    const adapter = createZaloPayAdapter(baseConfig);
    await expect(adapter.queryTransaction?.({ providerRef: "260813_abc123" })).rejects.toThrow(
      "ZaloPay query failed: -401",
    );
  });

  it("throws on HTTP failure instead of mapping it to not_found", async () => {
    fetchReturning({}, false, 500);
    const adapter = createZaloPayAdapter(baseConfig);
    await expect(adapter.queryTransaction?.({ providerRef: "260813_abc123" })).rejects.toThrow(
      "HTTP 500",
    );
  });
});
