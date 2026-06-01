/**
 * SDK client tests — transport behavior with a mocked fetch.
 *
 * Locks: auth header attachment, correct checkout DTO (F4: amountVnd, never
 * amountMicros/currency), error-envelope → PaykitApiError mapping, idempotency
 * header on refunds, and absence of any mint surface (F11 — no apiKeys.create).
 */
import { describe, expect, it, vi } from "vitest";
import { PaykitApiError, createPaykitClient } from "../src/index.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const BASE = "https://pay.example.com";
const KEY = "pk_live_testkey";

describe("createPaykitClient", () => {
  it("attaches the Authorization Bearer header on every call", async () => {
    const fetch = mockFetch(200, { apiVersion: "2026-05-31", data: [] });
    const pk = createPaykitClient({ baseUrl: BASE, apiKey: KEY, fetch });
    await pk.balances.get();
    const [, init] = fetch.mock.calls[0]!;
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("checkouts.create sends the SePay DTO (amountVnd) and not amountMicros/currency", async () => {
    const fetch = mockFetch(200, {
      apiVersion: "2026-05-31",
      data: {
        transactionId: "11111111-1111-1111-1111-111111111111",
        provider: "sepay",
        expiresAt: "2026-06-01T00:00:00.000Z",
        discountApplied: false,
      },
    });
    const pk = createPaykitClient({ baseUrl: BASE, apiKey: KEY, fetch });
    const res = await pk.checkouts.create({ provider: "sepay", amountVnd: 50_000 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/checkouts`);
    expect(init!.method).toBe("POST");
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual({ provider: "sepay", amountVnd: 50_000 });
    expect(sent).not.toHaveProperty("amountMicros");
    expect(sent).not.toHaveProperty("currency");
    expect(res.data.transactionId).toBeTruthy();
  });

  it("maps the error envelope to a thrown PaykitApiError with code + status", async () => {
    const fetch = mockFetch(403, {
      error: { code: "FORBIDDEN", message: "insufficient permissions" },
    });
    const pk = createPaykitClient({ baseUrl: BASE, apiKey: KEY, fetch });
    await expect(pk.balances.get()).rejects.toMatchObject({
      name: "PaykitApiError",
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(pk.balances.get()).rejects.toBeInstanceOf(PaykitApiError);
  });

  it("payments.list serializes query params", async () => {
    const fetch = mockFetch(200, { apiVersion: "2026-05-31", data: [] });
    const pk = createPaykitClient({ baseUrl: BASE, apiKey: KEY, fetch });
    await pk.payments.list({ limit: 10, offset: 20 });
    const [url] = fetch.mock.calls[0]!;
    expect(url).toContain("/v1/payments?");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=20");
  });

  it("refunds.create attaches the Idempotency-Key header", async () => {
    const fetch = mockFetch(200, {
      apiVersion: "2026-05-31",
      data: { state: "completed" },
    });
    const pk = createPaykitClient({ baseUrl: BASE, apiKey: KEY, fetch });
    await pk.refunds.create(
      {
        transactionId: "22222222-2222-2222-2222-222222222222",
        amountMicros: "1000000",
        reason: "duplicate charge",
      },
      { idempotencyKey: "refund-0001-abc" },
    );
    const [, init] = fetch.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("refund-0001-abc");
  });

  it("does NOT expose a key-minting surface (F11 — jwt plane only)", () => {
    const pk = createPaykitClient({ baseUrl: BASE, apiKey: KEY, fetch: mockFetch(200, {}) });
    expect((pk as Record<string, unknown>).apiKeys).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetch = mockFetch(200, { apiVersion: "2026-05-31", data: [] });
    const pk = createPaykitClient({ baseUrl: `${BASE}/`, apiKey: KEY, fetch });
    await pk.balances.get();
    const [url] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/v1/balances`);
  });
});
