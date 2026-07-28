/**
 * BitPay adapter tests.
 *
 * Covers:
 *   - createCheckout: USD price conversion, non-USD rejection, orderId round-trip
 *   - unsigned-webhook fail-closed: verifyWebhookSignature=false, parseWebhookPayload=null
 *   - resolveWebhook fetch-back: trigger → GET /invoices/:id → authoritative event
 *   - resolveWebhook skip cases: bad JSON, missing id, non-2xx fetch-back
 *   - refund facade split: no signer → failed; with signer → pending_webhook
 *   - fetchTransactions: no signer → []; with signer → settled records
 */
import { describe, expect, it } from "vitest";
import { createBitpayAdapter, type BitpayMerchantSigner } from "../src/adapter.js";

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function mockFetch(
  responder: (input: { url: string; init?: RequestInit }) => { status: number; body: string },
): { fetcher: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push(body !== undefined ? { url, method, body } : { url, method });
    const result = responder({ url, init });
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const STUB_SIGNER: BitpayMerchantSigner = {
  sign: () => ({ identity: "pubkey-hex", signature: "sig-hex" }),
};

function makeAdapter(
  fetcher: typeof fetch,
  opts?: { merchantSigner?: BitpayMerchantSigner },
): ReturnType<typeof createBitpayAdapter> {
  return createBitpayAdapter({
    apiToken: "pos-token",
    fetcher,
    environment: "sandbox",
    ...opts,
  });
}

describe("createCheckout", () => {
  it("converts amountMicros to a USD price + returns hosted url", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: { id: "inv-123", url: "https://test.bitpay.com/invoice?id=inv-123", expirationTime: 1900000000000 },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.createCheckout({
      transactionId: "tx-uuid-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://test.bitpay.com/invoice?id=inv-123");
    expect(result.qrUrl).toBe("https://test.bitpay.com/invoice?id=inv-123");
    // providerSessionId MUST be omitted so the server stores providerRef =
    // transactionId. The webhook (invoiceToEvent) and reconciliation
    // (fetchTransactions) both key on orderId (= transactionId), not the BitPay
    // invoice id — returning the invoice id here would break the webhook lookup
    // and the payment would never credit.
    expect(result.providerSessionId).toBeUndefined();

    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(calls[0]?.url).toContain("/invoices");
    expect(body.price).toBe(50);
    expect(body.currency).toBe("USD");
    expect(body.orderId).toBe("tx-uuid-1");
  });

  it("keeps providerRef consistent: checkout fallback == webhook providerRef (round-trip)", async () => {
    // The invariant that the credit flow depends on: the value the server stores
    // as providerRef at checkout time must equal evt.providerRef the webhook
    // later parses. With providerSessionId omitted, the server falls back to
    // transactionId; BitPay echoes it as invoice.orderId in the fetched-back
    // invoice, and invoiceToEvent surfaces it as providerRef.
    const TX_ID = "round-trip-tx-1";
    const { fetcher } = mockFetch(({ url }) => {
      if (url.includes("/invoices/inv-rt")) {
        return {
          status: 200,
          body: JSON.stringify({
            data: { id: "inv-rt", orderId: TX_ID, status: "confirmed", price: 10, currency: "USD", amountPaid: 10 },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({ data: { id: "inv-rt", url: "https://test.bitpay.com/invoice?id=inv-rt" } }),
      };
    });
    const adapter = makeAdapter(fetcher);

    const checkout = await adapter.createCheckout({
      transactionId: TX_ID,
      tenantId: "t",
      ownerId: "o",
      amountMicros: 10_000_000n,
      currencyCode: "USD",
    });
    // Mirror the server: providerRef = providerSessionId ?? transactionId
    const storedProviderRef = checkout.providerSessionId ?? TX_ID;

    const evt = await adapter.resolveWebhook?.(JSON.stringify({ data: { id: "inv-rt" } }), {});
    expect(evt?.providerRef).toBe(storedProviderRef);
  });

  it("rejects non-USD currency", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-2",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 50_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD/);
  });
});

describe("unsigned-webhook fail-closed", () => {
  it("verifyWebhookSignature always returns false (BitPay never signs IPNs)", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    expect(adapter.verifyWebhookSignature("{}", {})).toBe(false);
  });

  it("parseWebhookPayload always returns null (sync path must not credit)", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    expect(adapter.parseWebhookPayload("{}", {})).toBeNull();
  });
});

describe("resolveWebhook — fetch-back authoritative verification", () => {
  it("fetches GET /invoices/:id and emits payment.completed for a confirmed invoice", async () => {
    const { fetcher, calls } = mockFetch(({ url }) => {
      if (url.includes("/invoices/inv-123")) {
        return {
          status: 200,
          body: JSON.stringify({
            data: {
              id: "inv-123",
              orderId: "tx-uuid-1",
              status: "confirmed",
              price: 50,
              currency: "USD",
              amountPaid: 50,
            },
          }),
        };
      }
      return { status: 404, body: "{}" };
    });
    const adapter = makeAdapter(fetcher);

    // Untrusted IPN trigger (new BitPay shape nests id under data)
    const evt = await adapter.resolveWebhook?.(
      JSON.stringify({ event: { name: "invoice_confirmed" }, data: { id: "inv-123" } }),
      {},
    );

    expect(calls.some((c) => c.method === "GET" && c.url.includes("/invoices/inv-123"))).toBe(true);
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.providerRef).toBe("tx-uuid-1");
    expect(evt?.amountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
  });

  it("trusts the fetched status, NOT the IPN body (forged status ignored)", async () => {
    const { fetcher } = mockFetch(({ url }) => {
      if (url.includes("/invoices/inv-x")) {
        return {
          status: 200,
          body: JSON.stringify({ data: { id: "inv-x", orderId: "tx-x", status: "new" } }),
        };
      }
      return { status: 404, body: "{}" };
    });
    const adapter = makeAdapter(fetcher);
    // Attacker claims "complete" in the body; real invoice is still "new" → skip.
    const evt = await adapter.resolveWebhook?.(
      JSON.stringify({ data: { id: "inv-x", status: "complete" } }),
      {},
    );
    expect(evt).toBeNull();
  });

  it("maps exceptionStatus=paidPartial → payment.underpaid", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: {
          id: "inv-up",
          orderId: "tx-up",
          status: "complete",
          exceptionStatus: "paidPartial",
          price: 50,
          currency: "USD",
          amountPaid: 40,
        },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const evt = await adapter.resolveWebhook?.(JSON.stringify({ data: { id: "inv-up" } }), {});
    expect(evt?.type).toBe("payment.underpaid");
    expect(evt?.expectedAmountMicros).toBe("50000000");
  });

  it("returns null on unparseable trigger body", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = await adapter.resolveWebhook?.("not-json", {});
    expect(evt).toBeNull();
    expect(calls).toHaveLength(0); // never reached fetch-back
  });

  it("returns null when trigger carries no invoice id", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = await adapter.resolveWebhook?.(JSON.stringify({ event: "x" }), {});
    expect(evt).toBeNull();
  });

  it("returns null when fetch-back is non-2xx (cannot authenticate → skip, BitPay retries)", async () => {
    const { fetcher } = mockFetch(() => ({ status: 500, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = await adapter.resolveWebhook?.(JSON.stringify({ data: { id: "inv-err" } }), {});
    expect(evt).toBeNull();
  });
});

describe("refund — merchant facade split", () => {
  it("returns failed with NO_MERCHANT_SIGNER when signer not configured", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "inv-123",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("NO_MERCHANT_SIGNER");
  });

  it("returns failed with MISSING_INVOICE_ID when providerRef absent", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher, { merchantSigner: STUB_SIGNER });
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 1_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_INVOICE_ID");
  });

  it("signs the request and returns pending_webhook on 2xx (async confirm)", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: { id: "refund-1", status: "pending" } }),
    }));
    const adapter = makeAdapter(fetcher, { merchantSigner: STUB_SIGNER });
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "inv-123",
    });
    expect(result.state).toBe("pending_webhook");
    const refundCall = calls.find((c) => c.url.includes("/refunds"));
    expect(refundCall?.method).toBe("POST");
    const body = JSON.parse(refundCall?.body ?? "{}");
    expect(body.invoiceId).toBe("inv-123");
    expect(body.amount).toBe(50);
  });

  it("returns pending_webhook on transient 5xx", async () => {
    const { fetcher } = mockFetch(() => ({ status: 503, body: "{}" }));
    const adapter = makeAdapter(fetcher, { merchantSigner: STUB_SIGNER });
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "inv-123",
    });
    expect(result.state).toBe("pending_webhook");
  });
});

describe("fetchTransactions", () => {
  it("returns [] when merchant signer absent (listing needs merchant facade)", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions({ since: new Date("2026-01-01") });
    expect(records).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns settled records (complete/confirmed) with signer", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          { id: "i1", orderId: "tx-a", status: "complete", price: 10, currency: "USD" },
          { id: "i2", orderId: "tx-b", status: "new", price: 20, currency: "USD" },
          { id: "i3", orderId: "tx-c", status: "confirmed", price: 30, currency: "USD" },
        ],
      }),
    }));
    const adapter = makeAdapter(fetcher, { merchantSigner: STUB_SIGNER });
    const records = await adapter.fetchTransactions({
      since: new Date("2026-01-01"),
      until: new Date("2026-02-01"),
    });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.providerRef).sort()).toEqual(["tx-a", "tx-c"]);
    expect(records.find((r) => r.providerRef === "tx-a")?.amountMicros).toBe("10000000");
  });
});
