/**
 * createSepayHttpPull / createSepayHttpFetcher — the default HTTP fetcher
 * against SePay's user API (`/userapi/transactions/list`).
 *
 * What matters:
 * - only incoming transfers whose memo carries the brand prefix map back to
 *   paykit records; foreign deposits and outgoing transfers are skipped, not
 *   reported as paykit_missing;
 * - paging via since_id does not double-count the anchor row (since_id is >=);
 * - transport/API failures THROW — an empty list is a factual claim that the
 *   account received nothing, and the reconciler believes it.
 */
import { describe, expect, it, vi } from "vitest";
import { createSepayHttpFetcher, createSepayHttpPull } from "../src/reconcile/sepay-fetcher.js";

type SepayRow = {
  id: string | number;
  amount_in?: string | number;
  transaction_content?: string | null;
  code?: string | null;
};

function okResponse(transactions: SepayRow[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 200, error: null, messages: { success: true }, transactions }),
  };
}

const window = {
  since: new Date("2026-08-01T00:00:00Z"),
  until: new Date("2026-08-02T00:00:00Z"),
};

describe("createSepayHttpPull", () => {
  it("maps prefixed incoming transfers to orderId + VND amount", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse([
        { id: "101", amount_in: "100000.00", transaction_content: "PAYKIT txn-abc thanh toan" },
        { id: "102", amount_in: "250000.00", transaction_content: "NAP TIEN PAYKIT txn-def" },
      ]),
    );
    const pull = createSepayHttpPull({ apiToken: "tok-1", fetchImpl: fetchImpl as never });
    const txns = await pull(window);
    expect(txns).toEqual([
      { id: "101", orderId: "txn-abc", transferAmount: 100_000 },
      { id: "102", orderId: "txn-def", transferAmount: 250_000 },
    ]);
  });

  it("sends the Bearer token and the window as UTC+7 timestamps", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([]));
    const pull = createSepayHttpPull({ apiToken: "tok-1", fetchImpl: fetchImpl as never });
    await pull(window);

    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer tok-1");
    const params = new URL(url).searchParams;
    // 2026-08-01T00:00:00Z is 07:00:00 on the same day in Vietnam.
    expect(params.get("transaction_date_min")).toBe("2026-08-01 07:00:00");
    expect(params.get("transaction_date_max")).toBe("2026-08-02 07:00:00");
  });

  it("skips outgoing transfers, zero amounts, and deposits without the prefix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse([
        { id: "1", amount_in: "0.00", transaction_content: "PAYKIT txn-out chuyen di" },
        { id: "2", amount_in: "50000.00", transaction_content: "chuyen tien khong lien quan" },
        { id: "3", amount_in: "75000.00", transaction_content: "PAYKIT txn-keep" },
      ]),
    );
    const pull = createSepayHttpPull({ apiToken: "tok-1", fetchImpl: fetchImpl as never });
    const txns = await pull(window);
    expect(txns).toEqual([{ id: "3", orderId: "txn-keep", transferAmount: 75_000 }]);
  });

  it("respects a custom brand prefix, matching the adapter's memo rule", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse([
        { id: "1", amount_in: "10000.00", transaction_content: "MYSHOP txn-1" },
        { id: "2", amount_in: "10000.00", transaction_content: "PAYKIT txn-2" },
      ]),
    );
    const pull = createSepayHttpPull({
      apiToken: "tok-1",
      brandPrefix: "MYSHOP",
      fetchImpl: fetchImpl as never,
    });
    const txns = await pull(window);
    expect(txns).toEqual([{ id: "1", orderId: "txn-1", transferAmount: 10_000 }]);
  });

  it("pages with since_id and drops the inclusive anchor row instead of double-counting", async () => {
    const fullPage: SepayRow[] = [
      { id: "10", amount_in: "1000.00", transaction_content: "PAYKIT txn-10" },
      { id: "11", amount_in: "1000.00", transaction_content: "PAYKIT txn-11" },
    ];
    const secondPage: SepayRow[] = [
      // since_id is >=, so row 11 comes back as the anchor of page 2.
      { id: "11", amount_in: "1000.00", transaction_content: "PAYKIT txn-11" },
      { id: "12", amount_in: "1000.00", transaction_content: "PAYKIT txn-12" },
    ];
    // A page as large as the limit means "maybe more" — the third page returns
    // only its anchor row, which signals the end of the window.
    const thirdPage: SepayRow[] = [
      { id: "12", amount_in: "1000.00", transaction_content: "PAYKIT txn-12" },
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(fullPage))
      .mockResolvedValueOnce(okResponse(secondPage))
      .mockResolvedValueOnce(okResponse(thirdPage));
    const pull = createSepayHttpPull({
      apiToken: "tok-1",
      pageLimit: 2,
      fetchImpl: fetchImpl as never,
    });
    const txns = await pull(window);
    expect(txns.map((t) => t.orderId)).toEqual(["txn-10", "txn-11", "txn-12"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const secondUrl = new URL(fetchImpl.mock.calls[1]?.[0] as string);
    expect(secondUrl.searchParams.get("since_id")).toBe("11");
    const thirdUrl = new URL(fetchImpl.mock.calls[2]?.[0] as string);
    expect(thirdUrl.searchParams.get("since_id")).toBe("12");
  });

  it("throws on HTTP failure — an empty list would be a false factual claim", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const pull = createSepayHttpPull({ apiToken: "tok-1", fetchImpl: fetchImpl as never });
    await expect(pull(window)).rejects.toThrow("HTTP 429");
  });

  it("throws when the API reports failure in the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 401, error: "Unauthorized", messages: { success: false } }),
    });
    const pull = createSepayHttpPull({ apiToken: "bad-token", fetchImpl: fetchImpl as never });
    await expect(pull(window)).rejects.toThrow("SePay transactions/list failed");
  });
});

describe("createSepayHttpFetcher", () => {
  it("wraps the HTTP pull into ProviderTxnRecord micros", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okResponse([{ id: "1", amount_in: "100000.00", transaction_content: "PAYKIT txn-abc" }]),
      );
    const fetcher = createSepayHttpFetcher({ apiToken: "tok-1", fetchImpl: fetchImpl as never });
    const records = await fetcher.list(window);
    expect(records).toEqual([
      { providerRef: "txn-abc", amountMicros: "100000000000", currencyCode: "VND" },
    ]);
  });
});
