/**
 * PayPal adapter tests — against a local mock of api-m.paypal.com.
 *
 * Covers:
 *   - createCheckout: order body (custom_id, value formatting, idempotency
 *     header), approval link selection, unsupported currency, HTTP error
 *   - OAuth: token cached across calls, refreshed once on a 401
 *   - resolveWebhook (fetch-back): ORDER.APPROVED captures; a 422 on capture
 *     falls back to the order's existing capture; CAPTURE.COMPLETED reads the
 *     capture (custom_id from the order when missing); declined → failed;
 *     refunds (API-made and dashboard-made); forged/unknown ids; 5xx throws
 *   - sync verify/parse are fail-closed
 *   - refund: completed, pending, 5xx/network → pending_webhook, 4xx → failed,
 *     missing capture id
 *   - fetchTransactions: settled-only filter, pagination, 31-day split,
 *     refresh-lag guard, HTTP error throws
 */
import type { PaymentProviderAdapter } from "@xeko-git-1/paykit";
import { describe, expect, it } from "vitest";
import { createPaypalAdapter } from "../src/adapter.js";
import { microsToPaypalValue, paypalValueToMicros } from "../src/amounts.js";

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Responder = (call: MockCall) => { status: number; body: unknown } | null;

function mockFetch(responder: Responder): { fetcher: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: MockCall = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 32400 }), {
        status: 200,
      });
    }
    const hit = responder(call);
    if (hit === null) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status });
  }) as typeof fetch;
  return { fetcher, calls };
}

function makeAdapter(responder: Responder) {
  const mock = mockFetch(responder);
  const adapter = createPaypalAdapter({
    clientId: "cid",
    clientSecret: "secret",
    sandbox: true,
    returnUrl: "https://app/return",
    fetcher: mock.fetcher,
  });
  return { adapter, calls: mock.calls };
}

const nonToken = (calls: MockCall[]) => calls.filter((c) => !c.url.endsWith("/oauth2/token"));

function capture(overrides: Record<string, unknown> = {}) {
  return {
    id: "CAP1",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "50.00" },
    custom_id: "tx-1",
    supplementary_data: { related_ids: { order_id: "ORD1" } },
    ...overrides,
  };
}

function resolve(adapter: PaymentProviderAdapter, eventType: string, resourceId: unknown) {
  if (adapter.resolveWebhook === undefined) throw new Error("expected resolveWebhook");
  return adapter.resolveWebhook(
    JSON.stringify({ id: "WH-1", event_type: eventType, resource: { id: resourceId } }),
    {},
  );
}

describe("amounts", () => {
  it("formats micros as PayPal decimal strings, zero-decimal aware", () => {
    expect(microsToPaypalValue("USD", 50_000_000n)).toBe("50.00");
    expect(microsToPaypalValue("USD", 19_990_000n)).toBe("19.99");
    expect(microsToPaypalValue("USD", 5_000n)).toBe("0.00");
    expect(microsToPaypalValue("JPY", 1_000_000_000n)).toBe("1000");
  });

  it("parses PayPal values without float rounding and rejects negatives", () => {
    expect(paypalValueToMicros("19.99")).toBe("19990000");
    expect(paypalValueToMicros("1000")).toBe("1000000000");
    expect(paypalValueToMicros("-5.00")).toBeNull();
    expect(paypalValueToMicros("abc")).toBeNull();
    expect(paypalValueToMicros(undefined)).toBeNull();
  });
});

describe("createCheckout", () => {
  it("creates a CAPTURE order carrying the paykit reference and returns the payer-action link", async () => {
    const { adapter, calls } = makeAdapter(({ url, method }) =>
      method === "POST" && url.endsWith("/v2/checkout/orders")
        ? {
            status: 200,
            body: {
              id: "ORD1",
              status: "PAYER_ACTION_REQUIRED",
              links: [
                { rel: "self", href: "https://api/ORD1" },
                {
                  rel: "payer-action",
                  href: "https://www.sandbox.paypal.com/checkoutnow?token=ORD1",
                },
              ],
            },
          }
        : null,
    );
    const result = await adapter.createCheckout({
      transactionId: "tx-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 19_990_000n,
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORD1");
    // provider_ref must stay = transactionId (custom_id), so no session id.
    expect(result.providerSessionId).toBeUndefined();

    const create = nonToken(calls)[0];
    expect(create?.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(create?.headers["PayPal-Request-Id"]).toBe("paykit-order-tx-1");
    expect(create?.headers.Authorization).toBe("Bearer tok-1");
    const body = JSON.parse(create?.body ?? "{}");
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].custom_id).toBe("tx-1");
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "19.99" });
    expect(body.payment_source.paypal.experience_context.return_url).toBe("https://app/return");
  });

  it("falls back to the approve link when no payer-action link is present", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 201,
      body: { id: "ORD1", links: [{ rel: "approve", href: "https://paypal/approve" }] },
    }));
    const result = await adapter.createCheckout({
      transactionId: "tx-1",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000n,
      currencyCode: "EUR",
    });
    expect(result.webUrl).toBe("https://paypal/approve");
  });

  it("rejects an unsupported currency before calling PayPal", async () => {
    const { adapter, calls } = makeAdapter(() => null);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-1",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/VND/);
    expect(calls).toHaveLength(0);
  });

  it("throws with PayPal's error name on a failed create", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CURRENCY_NOT_SUPPORTED" }] },
    }));
    await expect(
      adapter.createCheckout({
        transactionId: "tx-1",
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/CURRENCY_NOT_SUPPORTED/);
  });
});

describe("OAuth token", () => {
  it("is fetched once and reused across calls", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: capture() }));
    await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1");
    await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1");
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("is refreshed once when a cached token is rejected", async () => {
    // API call 1 succeeds (caches the token), call 2 is rejected with 401,
    // the retry after a fresh token succeeds.
    let apiCalls = 0;
    const { adapter, calls } = makeAdapter(() => {
      apiCalls += 1;
      return apiCalls === 2 ? { status: 401, body: {} } : { status: 200, body: capture() };
    });
    await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1");
    const evt = await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1");
    expect(evt?.type).toBe("payment.completed");
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(2);
    expect(apiCalls).toBe(3);
  });
});

describe("resolveWebhook — fetch-back authentication", () => {
  it("captures on CHECKOUT.ORDER.APPROVED and credits from the capture result", async () => {
    const { adapter, calls } = makeAdapter(({ url, method }) =>
      method === "POST" && url.endsWith("/v2/checkout/orders/ORD1/capture")
        ? {
            status: 201,
            body: {
              id: "ORD1",
              status: "COMPLETED",
              purchase_units: [
                {
                  custom_id: "tx-1",
                  payments: { captures: [capture({ custom_id: undefined })] },
                },
              ],
            },
          }
        : null,
    );
    const evt = await resolve(adapter, "CHECKOUT.ORDER.APPROVED", "ORD1");
    expect(evt).toMatchObject({
      eventId: "paypal:capture.completed:CAP1",
      type: "payment.completed",
      providerRef: "tx-1",
      amountMicros: "50000000",
      currencyCode: "USD",
      providerPaymentId: "CAP1",
    });
    // A redelivered approval must not capture twice.
    expect(nonToken(calls)[0]?.headers["PayPal-Request-Id"]).toBe("paykit-capture-ORD1");
  });

  it("reads the order's existing capture when the capture call answers 422", async () => {
    const { adapter } = makeAdapter(({ url, method }) => {
      if (method === "POST") {
        return { status: 422, body: { name: "UNPROCESSABLE_ENTITY" } };
      }
      if (url.endsWith("/v2/checkout/orders/ORD1")) {
        return {
          status: 200,
          body: {
            id: "ORD1",
            status: "COMPLETED",
            purchase_units: [{ custom_id: "tx-1", payments: { captures: [capture()] } }],
          },
        };
      }
      return null;
    });
    const evt = await resolve(adapter, "CHECKOUT.ORDER.APPROVED", "ORD1");
    expect(evt?.eventId).toBe("paypal:capture.completed:CAP1");
  });

  it("emits the same event id from both approval and capture paths", async () => {
    const order = {
      id: "ORD1",
      status: "COMPLETED",
      purchase_units: [{ custom_id: "tx-1", payments: { captures: [capture()] } }],
    };
    const { adapter } = makeAdapter(({ url }) =>
      url.includes("/capture") && !url.includes("/captures/")
        ? { status: 201, body: order }
        : url.endsWith("/v2/payments/captures/CAP1")
          ? { status: 200, body: capture() }
          : null,
    );
    const viaApproval = await resolve(adapter, "CHECKOUT.ORDER.APPROVED", "ORD1");
    const viaCapture = await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1");
    expect(viaApproval?.eventId).toBe(viaCapture?.eventId);
    expect(viaApproval?.providerRef).toBe(viaCapture?.providerRef);
  });

  it("recovers the reference from the order when the capture lacks custom_id", async () => {
    const { adapter } = makeAdapter(({ url }) => {
      if (url.endsWith("/v2/payments/captures/CAP1")) {
        return { status: 200, body: capture({ custom_id: undefined }) };
      }
      if (url.endsWith("/v2/checkout/orders/ORD1")) {
        return { status: 200, body: { id: "ORD1", purchase_units: [{ custom_id: "tx-1" }] } };
      }
      return null;
    });
    const evt = await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1");
    expect(evt?.providerRef).toBe("tx-1");
  });

  it("trusts PayPal's state, not the delivery: a pending capture credits nothing", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: capture({ status: "PENDING" }),
    }));
    expect(await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1")).toBeNull();
  });

  it("maps a declined capture to payment.failed", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: capture({ status: "DECLINED" }),
    }));
    const evt = await resolve(adapter, "PAYMENT.CAPTURE.DECLINED", "CAP1");
    expect(evt).toMatchObject({ type: "payment.failed", providerRef: "tx-1" });
  });

  it("maps an API-made refund to payment.refunded with its own refund id", async () => {
    const { adapter } = makeAdapter(({ url }) =>
      url.endsWith("/v2/payments/refunds/REF1")
        ? {
            status: 200,
            body: {
              id: "REF1",
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "5.00" },
              custom_id: "tx-1",
            },
          }
        : null,
    );
    const evt = await resolve(adapter, "PAYMENT.CAPTURE.REFUNDED", "REF1");
    expect(evt).toMatchObject({
      type: "payment.refunded",
      providerRef: "tx-1",
      refundAmountMicros: "5000000",
      providerRefundId: "REF1",
    });
  });

  it("finds a dashboard-made refund's payment through its parent capture", async () => {
    const { adapter } = makeAdapter(({ url }) => {
      if (url.endsWith("/v2/payments/refunds/REF2")) {
        return {
          status: 200,
          body: {
            id: "REF2",
            status: "COMPLETED",
            amount: { currency_code: "USD", value: "1.00" },
            links: [{ rel: "up", href: "https://api-m.paypal.com/v2/payments/captures/CAP1" }],
          },
        };
      }
      if (url.endsWith("/v2/payments/captures/CAP1")) return { status: 200, body: capture() };
      return null;
    });
    const evt = await resolve(adapter, "PAYMENT.CAPTURE.REFUNDED", "REF2");
    expect(evt?.providerRef).toBe("tx-1");
  });

  it("drops a forged delivery whose id PayPal does not know", async () => {
    const { adapter } = makeAdapter(() => null); // every lookup 404s
    expect(await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "FORGED1")).toBeNull();
  });

  it("never puts a malformed resource id into a URL", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: capture() }));
    expect(await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "../../v1/oauth2")).toBeNull();
    expect(await resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", 42)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("ignores event types it does not handle and unparseable bodies", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, body: capture() }));
    expect(await resolve(adapter, "CUSTOMER.DISPUTE.CREATED", "CAP1")).toBeNull();
    expect(await adapter.resolveWebhook?.("not json", {})).toBeNull();
  });

  it("throws on a provider 5xx so the delivery is retried", async () => {
    const { adapter } = makeAdapter(() => ({ status: 503, body: {} }));
    await expect(resolve(adapter, "PAYMENT.CAPTURE.COMPLETED", "CAP1")).rejects.toThrow(/503/);
  });

  it("keeps the sync verify/parse path fail-closed", () => {
    const { adapter } = makeAdapter(() => null);
    expect(adapter.verifyWebhookSignature("{}", {})).toBe(false);
    expect(adapter.parseWebhookPayload("{}", {})).toBeNull();
  });
});

describe("refund", () => {
  const input = {
    transactionId: "tx-1",
    amountMicros: 5_000_000n,
    idempotencyKey: "idem-1",
    reason: "customer request",
    providerRef: "CAP1",
  };

  function refundAdapter(refund: { status: number; body: unknown } | "throw") {
    return makeAdapter(({ url, method }) => {
      if (method === "GET" && url.endsWith("/v2/payments/captures/CAP1")) {
        return { status: 200, body: capture() };
      }
      if (method === "POST" && url.endsWith("/v2/payments/captures/CAP1/refund")) {
        if (refund === "throw") throw new Error("socket hang up");
        return refund;
      }
      return null;
    });
  }

  it("refunds the capture in its own currency with the idempotency key", async () => {
    const { adapter, calls } = refundAdapter({
      status: 201,
      body: { id: "REF1", status: "COMPLETED" },
    });
    expect(await adapter.refund(input)).toEqual({ state: "completed", providerRefundId: "REF1" });
    const post = nonToken(calls).find((c) => c.method === "POST");
    expect(post?.headers["PayPal-Request-Id"]).toBe("idem-1");
    const body = JSON.parse(post?.body ?? "{}");
    expect(body.amount).toEqual({ currency_code: "USD", value: "5.00" });
    expect(body.custom_id).toBe("tx-1");
  });

  it("maps PENDING to pending_webhook", async () => {
    const { adapter } = refundAdapter({ status: 201, body: { id: "REF1", status: "PENDING" } });
    expect(await adapter.refund(input)).toEqual({
      state: "pending_webhook",
      providerRefundId: "REF1",
    });
  });

  it("treats a 5xx as ambiguous, not failed (the refund may have gone through)", async () => {
    const { adapter } = refundAdapter({ status: 500, body: {} });
    expect((await adapter.refund(input)).state).toBe("pending_webhook");
  });

  it("treats a network error on the refund call as ambiguous", async () => {
    const { adapter } = refundAdapter("throw");
    expect((await adapter.refund(input)).state).toBe("pending_webhook");
  });

  it("fails cleanly on a 4xx rejection", async () => {
    const { adapter } = refundAdapter({
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] },
    });
    const result = await adapter.refund(input);
    expect(result.state).toBe("failed");
    expect(result.error?.message).toMatch(/REFUND_AMOUNT_EXCEEDED/);
  });

  it("fails without calling PayPal when no capture id was recorded", async () => {
    const { adapter, calls } = refundAdapter({ status: 201, body: {} });
    const { providerRef: _ignored, ...withoutRef } = input;
    expect((await adapter.refund(withoutRef)).state).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("fetchTransactions — Transaction Search", () => {
  const window = {
    since: new Date("2026-08-01T00:00:00Z"),
    until: new Date("2026-08-10T00:00:00Z"),
  };
  const REFRESHED = "2026-08-11T00:00:00Z";

  function row(status: string, custom: string | undefined, value: string) {
    return {
      transaction_info: {
        transaction_id: `T-${custom}-${value}`,
        transaction_status: status,
        transaction_amount: { currency_code: "USD", value },
        ...(custom !== undefined ? { custom_field: custom } : {}),
      },
    };
  }

  it("returns settled paykit payments only, keyed on custom_field", async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 200,
      body: {
        last_refreshed_datetime: REFRESHED,
        total_pages: 1,
        transaction_details: [
          row("S", "tx-1", "50.00"),
          row("F", "tx-2", "20.00"), // partially refunded: still settled
          row("P", "tx-3", "10.00"), // pending: skipped
          row("D", "tx-4", "10.00"), // denied: skipped
          row("S", undefined, "99.00"), // not a paykit payment
          row("S", "tx-1", "-5.00"), // refund row: negative, skipped
        ],
      },
    }));
    const records = await adapter.fetchTransactions(window);
    expect(records).toEqual([
      { providerRef: "tx-1", amountMicros: "50000000", currencyCode: "USD" },
      { providerRef: "tx-2", amountMicros: "20000000", currencyCode: "USD" },
    ]);
    const url = new URL(nonToken(calls)[0]?.url ?? "");
    expect(url.searchParams.get("start_date")).toBe("2026-08-01T00:00:00Z");
    expect(url.searchParams.get("end_date")).toBe("2026-08-10T00:00:00Z");
  });

  it("follows pages to total_pages", async () => {
    const { adapter, calls } = makeAdapter(({ url }) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const rows = Array.from({ length: page === 1 ? 500 : 3 }, (_, i) =>
        row("S", `tx-${page}-${i}`, "1.00"),
      );
      return {
        status: 200,
        body: { last_refreshed_datetime: REFRESHED, total_pages: 2, transaction_details: rows },
      };
    });
    const records = await adapter.fetchTransactions(window);
    expect(records).toHaveLength(503);
    expect(nonToken(calls)).toHaveLength(2);
  });

  it("splits a window longer than 31 days into spans", async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 200,
      body: { last_refreshed_datetime: "2026-12-01T00:00:00Z", total_pages: 1 },
    }));
    await adapter.fetchTransactions({
      since: new Date("2026-08-01T00:00:00Z"),
      until: new Date("2026-10-15T00:00:00Z"),
    });
    const spans = nonToken(calls).map((c) => new URL(c.url).searchParams.get("start_date"));
    expect(spans).toEqual(["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", "2026-10-02T00:00:00Z"]);
  });

  it("refuses to list a window PayPal's data has not caught up to", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 200,
      body: {
        last_refreshed_datetime: "2026-08-09T21:00:00Z",
        total_pages: 1,
        transaction_details: [row("S", "tx-1", "50.00")],
      },
    }));
    await expect(adapter.fetchTransactions(window)).rejects.toThrow(/refreshed/);
  });

  it("throws on HTTP failure instead of returning a misleading empty list", async () => {
    const { adapter } = makeAdapter(() => ({ status: 500, body: {} }));
    await expect(adapter.fetchTransactions(window)).rejects.toThrow(/HTTP 500/);
  });
});
