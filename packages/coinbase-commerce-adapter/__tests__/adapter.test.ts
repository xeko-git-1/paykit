/**
 * Coinbase Commerce adapter tests. No network: every call goes through an
 * injected fetcher.
 *
 * Covers createCheckout (price conversion, reference round-trip, currency
 * rejection), signature verification, event mapping including the unresolved
 * states, the refund-unsupported outcome, and window/paging behaviour in
 * fetchTransactions.
 */
import { describe, expect, it } from "vitest";
import { createCoinbaseCommerceAdapter } from "../src/adapter.js";
import { PAYKIT_REFERENCE_METADATA_KEY } from "../src/webhook-events.js";
import {
  COINBASE_COMMERCE_SIGNATURE_HEADER,
  computeCoinbaseCommerceSignature,
} from "../src/webhook-verifier.js";

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push(body !== undefined ? { url, method, headers, body } : { url, method, headers });
    const result = responder({ url, init });
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const SECRET = "whsec-test";

function makeAdapter(fetcher: typeof fetch) {
  return createCoinbaseCommerceAdapter({
    apiKey: "cc-api-key",
    webhookSecret: SECRET,
    fetcher,
  });
}

/** A webhook envelope for one charge, with paykit's reference in metadata. */
function eventBody(opts: {
  type: string;
  reference?: string;
  eventId?: string;
  priceUsd?: string;
  paidLocalUsd?: string;
  timeline?: { status: string; context?: string };
}): string {
  const timeline = opts.timeline
    ? [
        {
          time: "2026-05-02T00:00:00Z",
          status: opts.timeline.status,
          ...(opts.timeline.context !== undefined ? { context: opts.timeline.context } : {}),
        },
      ]
    : [];
  return JSON.stringify({
    event: {
      id: opts.eventId ?? "evt-1",
      type: opts.type,
      data: {
        id: "charge-uuid",
        code: "ABCD1234",
        pricing: { local: { amount: opts.priceUsd ?? "50.00", currency: "USD" } },
        metadata:
          opts.reference === undefined ? {} : { [PAYKIT_REFERENCE_METADATA_KEY]: opts.reference },
        timeline,
        ...(opts.paidLocalUsd !== undefined
          ? { payments: [{ status: "CONFIRMED", value: { local: { amount: opts.paidLocalUsd } } }] }
          : {}),
      },
    },
  });
}

describe("createCheckout", () => {
  it("prices the charge in USD and carries the transaction id as the merchant reference", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: { id: "charge-uuid", hosted_url: "https://commerce.coinbase.com/charges/ABCD1234" },
      }),
    }));
    const result = await makeAdapter(fetcher).createCheckout({
      transactionId: "tx-uuid-1",
      tenantId: "tenant-1",
      ownerId: "owner-1",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://commerce.coinbase.com/charges/ABCD1234");
    // No providerSessionId, so the server stores provider_ref = transactionId —
    // the value Coinbase echoes in charge metadata on every event. Returning the
    // charge id would leave inbound webhooks matching no row.
    expect(result.providerSessionId).toBeUndefined();

    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.local_price).toEqual({ amount: "50.00", currency: "USD" });
    // fixed_price, not no_price: a no_price charge would let the payer send any
    // amount at all.
    expect(body.pricing_type).toBe("fixed_price");
    expect(body.metadata[PAYKIT_REFERENCE_METADATA_KEY]).toBe("tx-uuid-1");
    expect(calls[0]?.headers["X-CC-Api-Key"]).toBe("cc-api-key");
    expect(calls[0]?.headers["X-CC-Version"]).toBe("2018-03-22");
  });

  it("rejects a non-USD currency", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    await expect(
      makeAdapter(fetcher).createCheckout({
        transactionId: "tx-2",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD/);
  });

  it("throws when the provider returns no hosted_url", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: JSON.stringify({ data: {} }) }));
    await expect(
      makeAdapter(fetcher).createCheckout({
        transactionId: "tx-3",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/hosted_url/);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a signature over the exact received bytes", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const raw = eventBody({ type: "charge:confirmed", reference: "tx-uuid-1" });
    const sig = computeCoinbaseCommerceSignature(raw, SECRET);
    expect(
      makeAdapter(fetcher).verifyWebhookSignature(raw, {
        [COINBASE_COMMERCE_SIGNATURE_HEADER]: sig,
      }),
    ).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const raw = eventBody({ type: "charge:confirmed", reference: "tx-uuid-1", priceUsd: "50.00" });
    const sig = computeCoinbaseCommerceSignature(raw, SECRET);
    const tampered = eventBody({
      type: "charge:confirmed",
      reference: "tx-uuid-1",
      priceUsd: "5000.00",
    });
    expect(
      makeAdapter(fetcher).verifyWebhookSignature(tampered, {
        [COINBASE_COMMERCE_SIGNATURE_HEADER]: sig,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature header without throwing", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const raw = eventBody({ type: "charge:confirmed", reference: "tx-uuid-1" });
    expect(makeAdapter(fetcher).verifyWebhookSignature(raw, {})).toBe(false);
  });

  it("rejects a truncated signature rather than raising on a length mismatch", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const raw = eventBody({ type: "charge:confirmed", reference: "tx-uuid-1" });
    const sig = computeCoinbaseCommerceSignature(raw, SECRET).slice(0, 20);
    expect(
      makeAdapter(fetcher).verifyWebhookSignature(raw, {
        [COINBASE_COMMERCE_SIGNATURE_HEADER]: sig,
      }),
    ).toBe(false);
  });

  it("still accepts the previous secret during a rotation", () => {
    const adapter = createCoinbaseCommerceAdapter({
      apiKey: "k",
      webhookSecret: ["whsec-new", SECRET],
      fetcher: (async () => new Response("{}")) as typeof fetch,
    });
    const raw = eventBody({ type: "charge:confirmed", reference: "tx-uuid-1" });
    const sig = computeCoinbaseCommerceSignature(raw, SECRET);
    expect(adapter.verifyWebhookSignature(raw, { [COINBASE_COMMERCE_SIGNATURE_HEADER]: sig })).toBe(
      true,
    );
  });
});

describe("parseWebhookPayload", () => {
  function parse(raw: string) {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    return makeAdapter(fetcher).parseWebhookPayload(raw, {});
  }

  it("maps charge:confirmed to payment.completed keyed on the merchant reference", () => {
    const evt = parse(
      eventBody({
        type: "charge:confirmed",
        reference: "tx-uuid-1",
        priceUsd: "50.00",
        paidLocalUsd: "50.00",
      }),
    );
    expect(evt?.type).toBe("payment.completed");
    // The provider_ref stored at checkout must equal this, or the router lookup
    // misses the row and nothing is ever credited.
    expect(evt?.providerRef).toBe("tx-uuid-1");
    expect(evt?.amountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
  });

  it("maps charge:resolved to payment.completed", () => {
    const evt = parse(eventBody({ type: "charge:resolved", reference: "tx-uuid-1" }));
    expect(evt?.type).toBe("payment.completed");
  });

  it("credits the invoiced price when the customer overpays", () => {
    // Overpaying to cover fees is routine in crypto. Crediting the on-chain
    // amount would put more in the wallet than was ever charged for.
    const evt = parse(
      eventBody({
        type: "charge:confirmed",
        reference: "tx-uuid-1",
        priceUsd: "50.00",
        paidLocalUsd: "52.00",
      }),
    );
    expect(evt?.type).toBe("payment.amount_mismatch");
    expect(evt?.expectedAmountMicros).toBe("50000000");
  });

  it("quarantines instead of crediting when the settled amount drifts past 5 bps", () => {
    const evt = parse(
      eventBody({
        type: "charge:confirmed",
        reference: "tx-uuid-1",
        priceUsd: "100.00",
        paidLocalUsd: "99.00",
      }),
    );
    expect(evt?.type).toBe("payment.amount_mismatch");
  });

  it("still completes within the 5 bps rounding band", () => {
    const evt = parse(
      eventBody({
        type: "charge:confirmed",
        reference: "tx-uuid-1",
        priceUsd: "100.00",
        paidLocalUsd: "100.001",
      }),
    );
    expect(evt?.type).toBe("payment.completed");
    // Credits the price, not the fractionally larger on-chain figure.
    expect(evt?.amountMicros).toBe("100000000");
  });

  it("maps an expired charge to payment.expired, not payment.failed", () => {
    // The two differ downstream: an expiry releases the discount reservation and
    // reads as abandonment rather than a terminal error.
    const evt = parse(
      eventBody({
        type: "charge:failed",
        reference: "tx-uuid-1",
        timeline: { status: "EXPIRED" },
      }),
    );
    expect(evt?.type).toBe("payment.expired");
  });

  it("maps a non-expiry failure to payment.failed", () => {
    const evt = parse(
      eventBody({
        type: "charge:failed",
        reference: "tx-uuid-1",
        timeline: { status: "CANCELED" },
      }),
    );
    expect(evt?.type).toBe("payment.failed");
  });

  it("reports an underpaid unresolved charge without moving the ledger", () => {
    const evt = parse(
      eventBody({
        type: "charge:pending",
        reference: "tx-uuid-1",
        priceUsd: "50.00",
        paidLocalUsd: "20.00",
        timeline: { status: "UNRESOLVED", context: "UNDERPAID" },
      }),
    );
    expect(evt?.type).toBe("payment.underpaid");
  });

  it("ignores an unresolved charge whose release is a merchant decision", () => {
    // MANUAL/MULTIPLE/DELAYED wait for charge:resolved. Deciding to release one
    // is not something this adapter may do on the merchant's behalf.
    for (const context of ["MANUAL", "MULTIPLE", "DELAYED"]) {
      const evt = parse(
        eventBody({
          type: "charge:delayed",
          reference: "tx-uuid-1",
          timeline: { status: "UNRESOLVED", context },
        }),
      );
      expect(evt).toBeNull();
    }
  });

  it("ignores in-flight events", () => {
    expect(parse(eventBody({ type: "charge:created", reference: "tx-uuid-1" }))).toBeNull();
    expect(parse(eventBody({ type: "charge:pending", reference: "tx-uuid-1" }))).toBeNull();
  });

  it("ignores a charge created outside paykit", () => {
    // No paykit reference means no row this event could belong to. Guessing from
    // the Coinbase charge id would credit an unrelated payment.
    expect(parse(eventBody({ type: "charge:confirmed" }))).toBeNull();
  });

  it("returns null rather than throwing on a body that is not JSON", () => {
    expect(parse("<html>gateway error</html>")).toBeNull();
  });

  it("gives each event of one charge a distinct id so none is dropped as a duplicate", () => {
    const confirmed = parse(
      eventBody({ type: "charge:confirmed", reference: "tx-uuid-1", eventId: "evt-a" }),
    );
    const resolved = parse(
      eventBody({ type: "charge:resolved", reference: "tx-uuid-1", eventId: "evt-b" }),
    );
    expect(confirmed?.eventId).not.toBe(resolved?.eventId);
  });
});

describe("providerRef round-trip", () => {
  it("checkout's stored reference equals the webhook's providerRef", async () => {
    // Mirrors the server rule `provider_ref = providerSessionId ?? transactionId`.
    // If these ever diverge the router finds no row, answers 200, and the payment
    // is silently never credited.
    const TX_ID = "tx-roundtrip-1";
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ data: { id: "charge-uuid", hosted_url: "https://pay.example/x" } }),
    }));
    const adapter = makeAdapter(fetcher);

    const checkout = await adapter.createCheckout({
      transactionId: TX_ID,
      tenantId: "t",
      ownerId: "o",
      amountMicros: 10_000_000n,
      currencyCode: "USD",
    });
    const storedProviderRef = checkout.providerSessionId ?? TX_ID;

    const evt = adapter.parseWebhookPayload(
      eventBody({ type: "charge:confirmed", reference: TX_ID }),
      {},
    );
    expect(evt?.providerRef).toBe(storedProviderRef);
  });
});

describe("refund", () => {
  it("reports unsupported, because the provider has no refund endpoint", async () => {
    // Not `failed` — nothing was rejected — and not `pending_webhook`, which would
    // strand the transaction waiting for an event that cannot arrive.
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: "{}" }));
    const result = await makeAdapter(fetcher).refund({
      transactionId: "tx-1",
      amountMicros: 10_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "tx-1",
    });
    expect(result.state).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });
});

describe("fetchTransactions", () => {
  function charge(opts: {
    reference?: string;
    priceUsd: string;
    confirmedAt?: string;
    createdAt?: string;
  }) {
    return {
      id: `charge-${opts.reference ?? "anon"}`,
      pricing: { local: { amount: opts.priceUsd, currency: "USD" } },
      metadata:
        opts.reference === undefined ? {} : { [PAYKIT_REFERENCE_METADATA_KEY]: opts.reference },
      created_at: opts.createdAt ?? "2026-05-10T00:00:00Z",
      ...(opts.confirmedAt !== undefined ? { confirmed_at: opts.confirmedAt } : {}),
    };
  }

  it("returns settled charges inside the window, USD-normalized", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          charge({ reference: "tx-a", priceUsd: "10.00", confirmedAt: "2026-05-10T00:00:00Z" }),
          // Never confirmed — nothing settled, so nothing to reconcile.
          charge({ reference: "tx-b", priceUsd: "20.00" }),
          // Outside the window.
          charge({ reference: "tx-c", priceUsd: "30.00", confirmedAt: "2026-04-01T00:00:00Z" }),
        ],
        pagination: { limit: 100, yielded: 3, cursor_range: [] },
      }),
    }));
    const records = await makeAdapter(fetcher).fetchTransactions({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-29T00:00:00Z"),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.providerRef).toBe("tx-a");
    expect(records[0]?.amountMicros).toBe("10000000");
    expect(records[0]?.currencyCode).toBe("USD");
  });

  it("skips a charge with no paykit reference", async () => {
    // Charges created outside paykit share the merchant account. Reporting one as
    // a provider record with no paykit row would be a permanent false finding.
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [charge({ priceUsd: "10.00", confirmedAt: "2026-05-10T00:00:00Z" })],
        pagination: { cursor_range: [] },
      }),
    }));
    const records = await makeAdapter(fetcher).fetchTransactions({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-29T00:00:00Z"),
    });
    expect(records).toHaveLength(0);
  });

  it("follows the cursor past a full page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      charge({
        reference: `tx-p1-${i}`,
        priceUsd: "1.00",
        confirmedAt: "2026-05-10T00:00:00Z",
        createdAt: "2026-05-10T00:00:00Z",
      }),
    );
    const { fetcher, calls } = mockFetch(({ url }) =>
      url.includes("starting_after=cursor-1")
        ? {
            status: 200,
            body: JSON.stringify({
              data: [
                charge({
                  reference: "tx-p2",
                  priceUsd: "7.00",
                  confirmedAt: "2026-05-09T00:00:00Z",
                  createdAt: "2026-05-09T00:00:00Z",
                }),
              ],
              pagination: { cursor_range: [] },
            }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              data: fullPage,
              pagination: { limit: 100, yielded: 100, cursor_range: ["cursor-0", "cursor-1"] },
            }),
          },
    );
    const records = await makeAdapter(fetcher).fetchTransactions({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-29T00:00:00Z"),
    });
    expect(calls).toHaveLength(2);
    expect(records).toHaveLength(101);
  });

  it("stops once a page predates the window", async () => {
    // Newest first, so a page entirely older than the window means there is
    // nothing left to find.
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          charge({
            reference: "tx-old",
            priceUsd: "1.00",
            confirmedAt: "2026-01-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
          }),
        ],
        pagination: { cursor_range: ["c-1"] },
      }),
    }));
    await makeAdapter(fetcher).fetchTransactions({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-29T00:00:00Z"),
    });
    expect(calls).toHaveLength(1);
  });

  it("throws rather than reporting an empty window when the call fails", async () => {
    // The reconciler reads an empty list as "the merchant settled nothing", so
    // swallowing this would record a failed run as a clean reconciliation.
    const { fetcher } = mockFetch(() => ({ status: 500, body: "{}" }));
    await expect(
      makeAdapter(fetcher).fetchTransactions({ since: new Date("2026-05-01T00:00:00Z") }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
