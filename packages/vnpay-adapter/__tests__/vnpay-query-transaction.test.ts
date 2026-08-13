/**
 * queryTransaction — VNPay querydr, the per-reference lookup the reconciler
 * uses because VNPay has no merchant-wide date-range listing.
 *
 * The checksum is the load-bearing part: querydr signs a pipe-joined field
 * order, NOT the sorted query-string canonical the payment URL uses. Signing
 * with the wrong canonical fails every call with code 97, which would read as
 * "reconciliation is broken" rather than "the signature is wrong".
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVnpayAdapter } from "../src/adapter.js";

const baseConfig = {
  tmnCode: "TESTTMN1",
  hashSecret: "secret-1",
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

describe("createVnpayAdapter — queryTransaction", () => {
  it("declares canListTransactions=false so the reconciler uses the per-row path", () => {
    const adapter = createVnpayAdapter(baseConfig);
    expect(adapter.canListTransactions).toBe(false);
    expect(typeof adapter.queryTransaction).toBe("function");
  });

  it("signs the querydr request with the pipe-joined canonical, not the URL canonical", async () => {
    const mock = fetchReturning({ vnp_ResponseCode: "00", vnp_TransactionStatus: "00" });
    const adapter = createVnpayAdapter(baseConfig);
    await adapter.queryTransaction?.({ providerRef: "txn-abc", createdAt: new Date() });

    const body = JSON.parse(mock.mock.calls[0]?.[1]?.body as string) as Record<string, string>;
    const expected = createHmac("sha512", "secret-1")
      .update(
        [
          body.vnp_RequestId,
          body.vnp_Version,
          body.vnp_Command,
          body.vnp_TmnCode,
          body.vnp_TxnRef,
          body.vnp_TransactionDate,
          body.vnp_CreateDate,
          body.vnp_IpAddr,
          body.vnp_OrderInfo,
        ].join("|"),
        "utf-8",
      )
      .digest("hex");
    expect(body.vnp_SecureHash).toBe(expected);
    expect(body.vnp_Command).toBe("querydr");
    expect(body.vnp_TxnRef).toBe("txn-abc");
  });

  it("maps a settled payment to a VND record — vnp_Amount is ×100", async () => {
    fetchReturning({
      vnp_ResponseCode: "00",
      vnp_TransactionStatus: "00",
      vnp_Amount: "10000000", // 100,000 VND × 100
    });
    const adapter = createVnpayAdapter(baseConfig);
    const result = await adapter.queryTransaction?.({ providerRef: "txn-abc" });
    expect(result).toEqual({
      status: "settled",
      record: {
        providerRef: "txn-abc",
        amountMicros: (100_000n * 1_000_000n).toString(),
        currencyCode: "VND",
      },
    });
  });

  it("maps transaction status 01 to pending", async () => {
    fetchReturning({ vnp_ResponseCode: "00", vnp_TransactionStatus: "01" });
    const adapter = createVnpayAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "txn-abc" })).toEqual({
      status: "pending",
    });
  });

  it("maps a failed payment (status 02) to not_found — no settled money", async () => {
    fetchReturning({ vnp_ResponseCode: "00", vnp_TransactionStatus: "02" });
    const adapter = createVnpayAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "txn-abc" })).toEqual({
      status: "not_found",
    });
  });

  it("maps response code 91 (transaction not found) to not_found", async () => {
    fetchReturning({ vnp_ResponseCode: "91" });
    const adapter = createVnpayAdapter(baseConfig);
    expect(await adapter.queryTransaction?.({ providerRef: "txn-missing" })).toEqual({
      status: "not_found",
    });
  });

  it("throws on any other query error code — an unanswered question is not an absence", async () => {
    fetchReturning({ vnp_ResponseCode: "97", vnp_Message: "Invalid checksum" });
    const adapter = createVnpayAdapter(baseConfig);
    await expect(adapter.queryTransaction?.({ providerRef: "txn-abc" })).rejects.toThrow(
      "VNPay querydr failed: 97",
    );
  });

  it("throws on HTTP failure instead of mapping it to not_found", async () => {
    fetchReturning({}, false, 503);
    const adapter = createVnpayAdapter(baseConfig);
    await expect(adapter.queryTransaction?.({ providerRef: "txn-abc" })).rejects.toThrow(
      "HTTP 503",
    );
  });
});
