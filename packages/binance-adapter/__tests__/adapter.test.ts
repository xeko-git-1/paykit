/**
 * Binance Pay adapter tests.
 *
 * Signature coverage uses a locally generated RSA-2048 keypair: the test signs
 * the canonical payload with the private key exactly as Binance would, and the
 * adapter verifies with the public key. That exercises the real node:crypto path
 * (payload layout, trailing newline, base64 decode) without a live merchant
 * account, which Binance does not offer publicly.
 */
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBinanceAdapter } from "../src/adapter.js";
import { fromMerchantTradeNo, toMerchantTradeNo } from "../src/merchant-trade-no.js";
import { mapBizStatusToEventType } from "../src/webhook-events.js";
import {
  buildSignaturePayload,
  generateNonce,
  normalizePublicKey,
  signRequest,
} from "../src/webhook-verifier.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Sign a webhook the way Binance does: RSA-SHA256 over the canonical payload. */
function signWebhook(
  body: string,
  timestamp = "1730000000000",
  nonce = "abcdefghijklmnopqrstuvwxyzABCDEF",
): { headers: Record<string, string>; body: string } {
  const signer = createSign("RSA-SHA256");
  signer.update(buildSignaturePayload(timestamp, nonce, body), "utf-8");
  signer.end();
  return {
    body,
    headers: {
      "binancepay-timestamp": timestamp,
      "binancepay-nonce": nonce,
      "binancepay-signature": signer.sign(privateKey).toString("base64"),
      "binancepay-certificate-sn": "cert-sn-1",
    },
  };
}

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function mockFetch(responder: (input: { url: string }) => { status: number; body: string }): {
  fetcher: typeof fetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(body !== undefined ? { body } : {}),
    });
    const result = responder({ url });
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

function makeAdapter(
  fetcher: typeof fetch,
  opts?: Partial<Parameters<typeof createBinanceAdapter>[0]>,
): ReturnType<typeof createBinanceAdapter> {
  return createBinanceAdapter({
    apiKey: "test-api-key",
    apiSecret: "test-api-secret",
    webhookPublicKey: PUBLIC_KEY_PEM,
    fetcher,
    ...opts,
  });
}

function orderOk(over?: Record<string, unknown>): string {
  return JSON.stringify({
    status: "SUCCESS",
    code: "000000",
    data: {
      prepayId: "1234567890123456789",
      checkoutUrl: "https://pay.binance.com/checkout/abc",
      qrcodeLink: "https://public.bnbstatic.com/qr/abc.png",
      deeplink: "bnc://app.binance.com/payment/secpay?tempToken=xyz",
      expireTime: 1_730_003_600_000,
      currency: "USD",
      totalFee: "50.00",
      ...over,
    },
  });
}

const TX_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const TX_COMPACT = "3f2504e04f8911d39a0c0305e82c3301";

/**
 * A realistic Binance `bizId`: an 18-digit long that exceeds
 * Number.MAX_SAFE_INTEGER. Kept as a string so no JS number literal ever rounds
 * it — the adapter reads `bizIdStr` for the same reason.
 */
const BIZ_ID_RAW = "123289163323899904";

describe("createCheckout", () => {
  it("posts a v3 order with signed headers and a Binance-legal merchantTradeNo", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: orderOk() }));
    const adapter = makeAdapter(fetcher);

    const result = await adapter.createCheckout({
      transactionId: TX_UUID,
      tenantId: "tenant-1",
      ownerId: "owner-1",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://pay.binance.com/checkout/abc");
    expect(result.qrUrl).toBe("https://public.bnbstatic.com/qr/abc.png");
    expect(result.mobileDeeplink).toBe("bnc://app.binance.com/payment/secpay?tempToken=xyz");
    expect(result.expiresAt).toEqual(new Date(1_730_003_600_000));

    const call = calls[0];
    expect(call?.url).toBe("https://bpay.binanceapi.com/binancepay/openapi/v3/order");
    expect(call?.method).toBe("POST");
    expect(call?.headers["BinancePay-Certificate-SN"]).toBe("test-api-key");
    // Nonce must be exactly 32 chars; signature is uppercase hex HMAC-SHA512.
    expect(call?.headers["BinancePay-Nonce"]).toMatch(/^[a-zA-Z]{32}$/);
    expect(call?.headers["BinancePay-Signature"]).toMatch(/^[0-9A-F]{128}$/);

    const body = JSON.parse(call?.body ?? "{}");
    expect(body.merchantTradeNo).toBe(TX_COMPACT);
    expect(body.orderAmount).toBe("50.00");
    expect(body.currency).toBe("USD");
    expect(body.env.terminalType).toBe("WEB");
    expect(body.goodsDetails).toHaveLength(1);
  });

  it("signs the exact bytes it sends", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: orderOk() }));
    const adapter = makeAdapter(fetcher, { webhookUrl: "https://app.example/webhooks/binance" });
    await adapter.createCheckout({
      transactionId: TX_UUID,
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_500_000n,
      currencyCode: "USD",
    });

    const call = calls[0];
    const expected = signRequest(
      call?.headers["BinancePay-Timestamp"] ?? "",
      call?.headers["BinancePay-Nonce"] ?? "",
      call?.body ?? "",
      "test-api-secret",
    );
    expect(call?.headers["BinancePay-Signature"]).toBe(expected);
    expect(JSON.parse(call?.body ?? "{}").webhookUrl).toBe("https://app.example/webhooks/binance");
    expect(JSON.parse(call?.body ?? "{}").orderAmount).toBe("1.50");
  });

  it("never returns providerSessionId, so provider_ref stays the transactionId", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: orderOk() }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.createCheckout({
      transactionId: TX_UUID,
      tenantId: "t",
      ownerId: "o",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });
    // Returning prepayId here would make the server store it as provider_ref and
    // the webhook (which echoes merchantTradeNo) would never find the row.
    expect(result.providerSessionId).toBeUndefined();
  });

  it("rejects non-USD currency", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: orderOk() }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: TX_UUID,
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD/);
  });

  it("throws when Binance returns HTTP 200 with status=FAIL", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        status: "FAIL",
        code: "400201",
        errorMessage: "merchantTradeNo is invalid or duplicated",
      }),
    }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: TX_UUID,
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/400201/);
  });

  it("throws when the order succeeds but carries no checkoutUrl", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ status: "SUCCESS", code: "000000", data: { prepayId: "1" } }),
    }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: TX_UUID,
        tenantId: "t",
        ownerId: "o",
        amountMicros: 1_000_000n,
        currencyCode: "USD",
      }),
    ).rejects.toThrow(/checkoutUrl/);
  });
});

describe("verifyWebhookSignature", () => {
  // Built as a raw string, not via JSON.stringify: bizId is an 18-digit long that
  // exceeds Number.MAX_SAFE_INTEGER, so routing it through a JS number literal
  // would round it and stop reproducing the bytes Binance actually signs.
  const payload =
    `{"bizType":"PAY","bizId":${BIZ_ID_RAW},"bizIdStr":"${BIZ_ID_RAW}","bizStatus":"PAY_SUCCESS",` +
    `"data":${JSON.stringify(JSON.stringify({ merchantTradeNo: TX_COMPACT, totalFee: 50, currency: "USD" }))}}`;

  it("accepts a genuine RSA-SHA256 signature", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const signed = signWebhook(payload);
    expect(adapter.verifyWebhookSignature(signed.body, signed.headers)).toBe(true);
  });

  it("rejects a body tampered after signing", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const signed = signWebhook(payload);
    // The amount lives inside the escaped `data` string, so tamper it there —
    // editing the outer envelope text would miss the field entirely.
    const tampered = payload.replace('\\"totalFee\\":50', '\\"totalFee\\":5000');
    expect(tampered).not.toBe(payload);
    expect(adapter.verifyWebhookSignature(tampered, signed.headers)).toBe(false);
  });

  it("rejects when timestamp or nonce differ from the signed pair", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const signed = signWebhook(payload);
    expect(
      adapter.verifyWebhookSignature(signed.body, {
        ...signed.headers,
        "binancepay-timestamp": "1730000000001",
      }),
    ).toBe(false);
    expect(
      adapter.verifyWebhookSignature(signed.body, {
        ...signed.headers,
        "binancepay-nonce": "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toBe(false);
  });

  it("rejects missing headers and a wrong key, and tolerates header casing", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const signed = signWebhook(payload);
    expect(adapter.verifyWebhookSignature(signed.body, {})).toBe(false);

    // Upper-case header names (stacks that do not normalize) must still verify.
    const upper = {
      "BinancePay-Timestamp": signed.headers["binancepay-timestamp"] as string,
      "BinancePay-Nonce": signed.headers["binancepay-nonce"] as string,
      "BinancePay-Signature": signed.headers["binancepay-signature"] as string,
    };
    expect(adapter.verifyWebhookSignature(signed.body, upper)).toBe(true);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongKeyAdapter = makeAdapter(fetcher, {
      webhookPublicKey: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    expect(wrongKeyAdapter.verifyWebhookSignature(signed.body, signed.headers)).toBe(false);
  });

  it("accepts a rotated key when several are configured", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const stale = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const adapter = makeAdapter(fetcher, {
      webhookPublicKey: [
        stale.publicKey.export({ type: "spki", format: "pem" }).toString(),
        PUBLIC_KEY_PEM,
      ],
    });
    const signed = signWebhook(payload);
    expect(adapter.verifyWebhookSignature(signed.body, signed.headers)).toBe(true);
  });

  it("accepts a bare base64 certPublic without PEM armour", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const bare = PUBLIC_KEY_PEM.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
    const adapter = makeAdapter(fetcher, { webhookPublicKey: bare });
    const signed = signWebhook(payload);
    expect(adapter.verifyWebhookSignature(signed.body, signed.headers)).toBe(true);
    expect(normalizePublicKey(bare)).toContain("-----BEGIN PUBLIC KEY-----");
  });
});

describe("parseWebhookPayload", () => {
  function envelope(over: Record<string, unknown>, data: Record<string, unknown>): string {
    return JSON.stringify({
      bizType: "PAY",
      // bizId is an 18-digit long that exceeds Number.MAX_SAFE_INTEGER, so it is
      // never read as a JS number — the adapter prefers bizIdStr for exactly
      // this reason. Kept as a string here so the fixture cannot round-trip a
      // rounded value and mask that precedence.
      bizIdStr: BIZ_ID_RAW,
      bizStatus: "PAY_SUCCESS",
      ...over,
      data: JSON.stringify(data),
    });
  }

  it("maps PAY_SUCCESS to payment.completed with USD micros", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = adapter.parseWebhookPayload(
      envelope({}, { merchantTradeNo: TX_COMPACT, totalFee: 50, currency: "USD" }),
      {},
    );
    expect(evt?.type).toBe("payment.completed");
    expect(evt?.amountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
    // prepayId must ride in providerPaymentId (for refunds), never as providerRef.
    expect(evt?.providerPaymentId).toBe(BIZ_ID_RAW);
    expect(evt?.metadata.prepayId).toBe(BIZ_ID_RAW);
  });

  it("quarantines a non-USD completion instead of crediting a coin amount", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    // A merchant not onboarded for USD prices in USDT; "0.01" USDT is not $0.01.
    const evt = adapter.parseWebhookPayload(
      envelope({}, { merchantTradeNo: TX_COMPACT, totalFee: "50.00", currency: "USDT" }),
      {},
    );
    expect(evt?.type).toBe("payment.amount_mismatch");
    expect(evt?.currencyCode).toBe("USDT");
  });

  it("maps PAY_CLOSED to expired and PAY_FAIL to failed", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const closed = adapter.parseWebhookPayload(
      envelope({ bizStatus: "PAY_CLOSED" }, { merchantTradeNo: TX_COMPACT, currency: "USD" }),
      {},
    );
    expect(closed?.type).toBe("payment.expired");
    const failed = adapter.parseWebhookPayload(
      envelope({ bizStatus: "PAY_FAIL" }, { merchantTradeNo: TX_COMPACT, currency: "USD" }),
      {},
    );
    expect(failed?.type).toBe("payment.failed");
  });

  it("maps REFUND_SUCCESS to payment.refunded with refundAmountMicros", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = adapter.parseWebhookPayload(
      envelope(
        { bizType: "PAY_REFUND", bizStatus: "REFUND_SUCCESS" },
        {
          merchantTradeNo: TX_COMPACT,
          totalFee: 50,
          currency: "USD",
          refundInfo: {
            orderAmount: "50.00000000",
            refundAmount: "20.00000000",
            refundedAmount: "20.00000000",
            refundRequestId: "idem-1",
            prepayId: "1234567890123456789",
            remainingAttempts: 9,
          },
        },
      ),
      {},
    );
    expect(evt?.type).toBe("payment.refunded");
    // Without this the webhook-router refund case early-returns and no debit lands.
    expect(evt?.refundAmountMicros).toBe("20000000");
    expect(evt?.providerPaymentId).toBe("1234567890123456789");
  });

  it("skips REFUND_REJECTED, PAYOUT, unknown statuses and malformed data", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    expect(
      adapter.parseWebhookPayload(
        envelope(
          { bizType: "PAY_REFUND", bizStatus: "REFUND_REJECTED" },
          { merchantTradeNo: TX_COMPACT },
        ),
        {},
      ),
    ).toBeNull();
    expect(
      adapter.parseWebhookPayload(
        envelope({ bizType: "PAYOUT", bizStatus: "SUCCESS" }, { merchantTradeNo: TX_COMPACT }),
        {},
      ),
    ).toBeNull();
    // data is not valid JSON
    expect(
      adapter.parseWebhookPayload(
        JSON.stringify({ bizType: "PAY", bizStatus: "PAY_SUCCESS", data: "{not json" }),
        {},
      ),
    ).toBeNull();
    // no merchantTradeNo → nothing to look up
    expect(adapter.parseWebhookPayload(envelope({}, { totalFee: 1 }), {})).toBeNull();
    expect(adapter.parseWebhookPayload("not json at all", {})).toBeNull();
  });

  it("omits refundAmountMicros on a non-USD refund so no coin amount is debited as dollars", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const evt = adapter.parseWebhookPayload(
      envelope(
        { bizType: "PAY_REFUND", bizStatus: "REFUND_SUCCESS" },
        {
          merchantTradeNo: TX_COMPACT,
          currency: "USDT",
          totalFee: "50.00",
          refundInfo: { refundAmount: "50.00000000", prepayId: "1" },
        },
      ),
      {},
    );
    // Still a refund event (so it dedups and is auditable), but with no
    // refundAmountMicros the router's refund case early-returns instead of
    // writing a coin amount into the USD ledger.
    expect(evt?.type).toBe("payment.refunded");
    expect(evt?.refundAmountMicros).toBeUndefined();
    expect(evt?.currencyCode).toBe("USDT");
  });

  it("takes the prepay id from bizIdStr, not the precision-losing bizId number", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    // Binance sends bizId as an 18-digit JSON number, past Number.MAX_SAFE_INTEGER.
    // Reading it as a JS number rounds the last digits, so the refund would later
    // be sent an id Binance cannot resolve. bizIdStr carries the exact value.
    // Number(BIZ_ID_RAW) rather than a literal: the literal itself would trip the
    // precision-loss lint, which is precisely the hazard under test here.
    const rounded = String(Number(BIZ_ID_RAW));
    // Sanity-check the premise: this id really is unrepresentable as a JS number.
    expect(rounded).not.toBe(BIZ_ID_RAW);

    const raw =
      `{"bizType":"PAY","bizId":${BIZ_ID_RAW},"bizIdStr":"${BIZ_ID_RAW}",` +
      `"bizStatus":"PAY_SUCCESS","data":${JSON.stringify(
        JSON.stringify({ merchantTradeNo: TX_COMPACT, totalFee: 50, currency: "USD" }),
      )}}`;
    const evt = adapter.parseWebhookPayload(raw, {});
    expect(evt?.providerPaymentId).toBe(BIZ_ID_RAW);
    expect(evt?.eventId).toContain(BIZ_ID_RAW);
    // A rounded id must never reach the refund API — Binance would 400202 it.
    expect(evt?.providerPaymentId).not.toBe(rounded);
  });

  it("gives partial refunds distinct event ids so neither is deduped away", () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const first = adapter.parseWebhookPayload(
      envelope(
        { bizType: "PAY_REFUND", bizStatus: "REFUND_SUCCESS" },
        {
          merchantTradeNo: TX_COMPACT,
          currency: "USD",
          refundInfo: { refundAmount: "10.00", refundRequestId: "idem-1", prepayId: "1" },
        },
      ),
      {},
    );
    const second = adapter.parseWebhookPayload(
      envelope(
        { bizType: "PAY_REFUND", bizStatus: "REFUND_SUCCESS" },
        {
          merchantTradeNo: TX_COMPACT,
          currency: "USD",
          refundInfo: { refundAmount: "10.00", refundRequestId: "idem-2", prepayId: "1" },
        },
      ),
      {},
    );
    expect(first?.eventId).not.toBe(second?.eventId);
  });
});

describe("providerRef round-trip invariant", () => {
  it("webhook providerRef equals the provider_ref the server stored at checkout", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: orderOk() }));
    const adapter = makeAdapter(fetcher);

    const checkout = await adapter.createCheckout({
      transactionId: TX_UUID,
      tenantId: "t",
      ownerId: "o",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });
    // The server stores providerSessionId ?? transactionId (checkout-router).
    const storedProviderRef = checkout.providerSessionId ?? TX_UUID;

    // Binance echoes the compacted merchantTradeNo in the notification.
    const evt = adapter.parseWebhookPayload(
      JSON.stringify({
        bizType: "PAY",
        bizIdStr: BIZ_ID_RAW,
        bizStatus: "PAY_SUCCESS",
        data: JSON.stringify({ merchantTradeNo: TX_COMPACT, totalFee: 50, currency: "USD" }),
      }),
      {},
    );

    // If these diverge the router's (provider, provider_ref) lookup finds no row
    // and a paid transaction is silently stranded as 'pending'.
    expect(evt?.providerRef).toBe(storedProviderRef);
    expect(evt?.providerRef).not.toBe("1234567890123456789");
  });
});

describe("merchantTradeNo mapping", () => {
  it("compacts a UUID to 32 alphanumeric chars and back", () => {
    expect(toMerchantTradeNo(TX_UUID)).toBe(TX_COMPACT);
    expect(toMerchantTradeNo(TX_UUID)).toHaveLength(32);
    expect(toMerchantTradeNo(TX_UUID)).toMatch(/^[0-9a-zA-Z]{1,32}$/);
    expect(fromMerchantTradeNo(TX_COMPACT)).toBe(TX_UUID);
  });

  it("passes through ids that are already Binance-legal", () => {
    expect(toMerchantTradeNo("order123")).toBe("order123");
    expect(fromMerchantTradeNo("order123")).toBe("order123");
  });

  it("throws rather than sending an id Binance would reject", () => {
    expect(() => toMerchantTradeNo("order_with_underscore")).toThrow(/alphanumeric/);
    expect(() => toMerchantTradeNo("a".repeat(33))).toThrow(/alphanumeric/);
  });
});

describe("refund", () => {
  it("fails fast when no prepayId is available", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: TX_UUID,
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_PREPAY_ID");
  });

  it("posts prepayId + refundRequestId and maps REFUNDED to completed", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        status: "SUCCESS",
        code: "000000",
        data: {
          refundId: 987_654_321,
          refundRequestId: "idem-1",
          prepayId: "1234567890123456789",
          refundStatus: "REFUNDED",
          duplicateRequest: "N",
        },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: TX_UUID,
      amountMicros: 20_000_000n,
      idempotencyKey: "idem-1",
      reason: "customer request",
      providerRef: "1234567890123456789",
    });

    expect(result.state).toBe("completed");
    expect(result.providerRefundId).toBe("987654321");
    const call = calls.find((c) => c.url.includes("/order/refund"));
    expect(call?.url).toBe("https://bpay.binanceapi.com/binancepay/openapi/order/refund");
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.prepayId).toBe("1234567890123456789");
    expect(body.refundRequestId).toBe("idem-1");
    expect(body.refundAmount).toBe("20.00");
  });

  it("maps a pending refundStatus to pending_webhook", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        status: "SUCCESS",
        code: "000000",
        data: { refundId: 1, refundStatus: "PENDING" },
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: TX_UUID,
      amountMicros: 20_000_000n,
      idempotencyKey: "idem-1",
      reason: "r",
      providerRef: "1234567890123456789",
    });
    expect(result.state).toBe("pending_webhook");
  });

  it("maps a deterministic rejection to failed, not pending_webhook", async () => {
    // 400202 ORDER_NOT_FOUND can never become a refund, so leaving the row in
    // refund_pending_webhook would strand it waiting for a webhook that never comes.
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ status: "FAIL", code: "400202", errorMessage: "ORDER_NOT_FOUND" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: TX_UUID,
      amountMicros: 20_000_000n,
      idempotencyKey: "idem-1",
      reason: "r",
      providerRef: "nope",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("400202");
  });

  it("maps a transient failure and a network error to pending_webhook", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        status: "FAIL",
        code: "400611",
        errorMessage: "INSUFFICIENT_BALANCE",
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const transient = await adapter.refund({
      transactionId: TX_UUID,
      amountMicros: 20_000_000n,
      idempotencyKey: "idem-1",
      reason: "r",
      providerRef: "1234567890123456789",
    });
    expect(transient.state).toBe("pending_webhook");
    expect(transient.error?.providerCode).toBe("400611");

    const throwing = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const netAdapter = makeAdapter(throwing);
    const netResult = await netAdapter.refund({
      transactionId: TX_UUID,
      amountMicros: 20_000_000n,
      idempotencyKey: "idem-1",
      reason: "r",
      providerRef: "1234567890123456789",
    });
    expect(netResult.state).toBe("pending_webhook");
    expect(netResult.error?.providerCode).toBe("NETWORK_ERROR");
  });

  it("maps a 5xx to pending_webhook so a refund in flight is not retried blindly", async () => {
    const { fetcher } = mockFetch(() => ({ status: 502, body: "<html>bad gateway</html>" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: TX_UUID,
      amountMicros: 20_000_000n,
      idempotencyKey: "idem-1",
      reason: "r",
      providerRef: "1234567890123456789",
    });
    expect(result.state).toBe("pending_webhook");
    expect(result.error?.providerCode).toBe("HTTP_502");
  });
});

describe("fetchTransactions", () => {
  it("returns empty because Binance Pay has no merchant-wide order list", async () => {
    const { fetcher, calls } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions({ since: new Date("2026-01-01") });
    expect(records).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("signature helpers", () => {
  it("builds the canonical payload with a trailing newline", () => {
    expect(buildSignaturePayload("123", "abc", "{}")).toBe("123\nabc\n{}\n");
  });

  it("generates a 32-character letter-only nonce", () => {
    const nonce = generateNonce(randomBytes);
    expect(nonce).toHaveLength(32);
    expect(nonce).toMatch(/^[a-zA-Z]{32}$/);
  });

  it("maps biz statuses independently of the envelope", () => {
    expect(mapBizStatusToEventType("PAY", "PAY_SUCCESS")).toBe("payment.completed");
    expect(mapBizStatusToEventType("PAY", "PAY_CLOSE")).toBe("payment.expired");
    expect(mapBizStatusToEventType("PAY_REFUND", "REFUND_SUCCESS")).toBe("payment.refunded");
    expect(mapBizStatusToEventType("PAY", "SOMETHING_NEW")).toBeNull();
    expect(mapBizStatusToEventType(undefined, undefined)).toBeNull();
  });
});
