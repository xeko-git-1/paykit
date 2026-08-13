/**
 * Crypto adapters e2e — checkout → provider webhook → ledger credit, for the
 * five crypto providers (Binance Pay, NowPayments, Cryptomus, BitPay, Coinbase
 * Commerce), with mocked providers so it runs in CI with no credentials.
 *
 * Two layers, same philosophy as packages/server/__tests__/checkout-webhook-
 * roundtrip-e2e.test.ts (which covers Binance's four siblings but not Binance):
 *
 *  Layer 1 drives each adapter's REAL createCheckout against a fake provider,
 *  reads the identifier the provider received off the wire, builds that
 *  provider's own payment.completed webhook from it, and asserts the normalized
 *  event keys on the exact provider_ref the server stored. For Binance this is
 *  the merchantTradeNo hyphen-compact/expand round-trip — the only place a UUID
 *  is transformed on the way out and must be reversed on the way in.
 *
 *  Layer 2 sends the full signed webhook through the REAL buildWebhookRouter
 *  and asserts a matching provider_ref credits the ledger and a mismatched one
 *  credits nothing (the silent money-losing failure mode).
 *
 * Binance-specific pins beyond the shared invariants:
 *  - RSA-SHA256 webhook signature over timestamp\nnonce\nbody\n verifies with
 *    the configured public key and fails on a tampered body.
 *  - A completion denominated in a coin (non-USD `currency`) normalizes to
 *    payment.amount_mismatch — quarantined, never credited as dollars.
 *  - REFUND_SUCCESS normalizes to payment.refunded with a USD refund amount.
 *
 * Live verification against the real provider APIs is NOT this file's job:
 * e2e/live-verify/ hosts the credential-gated harness (serve + verify CLI).
 */
import { createSign, generateKeyPairSync } from "node:crypto";

import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
} from "@xeko-git-1/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The router records every delivery in the inbox before processing it. Same
// stand-ins as the server round-trip suite, resolved to the same workspace
// modules the router imports.
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js", async () => {
  const { inboxRepoMock } = await import(
    "../../../packages/server/__tests__/helpers/webhook-inbox-repo-mock.js"
  );
  return inboxRepoMock();
});
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js", () => ({
  appendLedgerEntryIdempotent: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js", () => ({
  applyDelta: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js", () => ({
  findActiveByTransaction: vi.fn(),
  markCompleted: vi.fn(),
}));
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js", () => ({
  updateTransactionStatus: vi.fn(),
}));

import { applyDelta } from "@xeko-git-1/paykit-auth-core/db/repos/balance.repo.js";
import { appendLedgerEntryIdempotent } from "@xeko-git-1/paykit-auth-core/db/repos/ledger.repo.js";
import { updateTransactionStatus } from "@xeko-git-1/paykit-auth-core/db/repos/payment.repo.js";
import {
  BINANCE_NONCE_HEADER,
  BINANCE_SIGNATURE_HEADER,
  BINANCE_TIMESTAMP_HEADER,
  buildSignaturePayload,
  createBinanceAdapter,
} from "@xeko-git-1/paykit-binance";
import { createBitpayAdapter } from "@xeko-git-1/paykit-bitpay";
import {
  COINBASE_COMMERCE_SIGNATURE_HEADER,
  PAYKIT_REFERENCE_METADATA_KEY,
  computeCoinbaseCommerceSignature,
  createCoinbaseCommerceAdapter,
} from "@xeko-git-1/paykit-coinbase-commerce";
import { computeCryptomusSign, createCryptomusAdapter } from "@xeko-git-1/paykit-cryptomus";
import {
  NP_SIGNATURE_HEADER,
  canonicalize,
  computeNpSignature,
  createNowpaymentsAdapter,
} from "@xeko-git-1/paykit-nowpayments";
import { buildWebhookRouter } from "../../../packages/server/src/routes/webhooks/webhook-router.js";

const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;

const TX_ID = "c0000000-0000-4000-8000-00000000c0de";
const TENANT_ID = "tenant-crypto-e2e";
const OWNER_ID = "owner-crypto-e2e";

/** $50.00 — every crypto adapter settles the paykit ledger in USD. */
const USD_50_MICROS = 50_000_000n;

const NP_SECRET = "np-ipn-secret-e2e";
const CRYPTOMUS_KEY = "cryptomus-key-e2e";
const COINBASE_SECRET = "cc-whsec-e2e";

// One RSA pair stands in for Binance's webhook certificate: the private half
// plays Binance signing notifications, the public half is the adapter config.
const binanceKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const BINANCE_PUBLIC_PEM = binanceKeys.publicKey.export({ type: "spki", format: "pem" }) as string;

function signAsBinance(timestamp: string, nonce: string, rawBody: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(buildSignaturePayload(timestamp, nonce, rawBody), "utf-8");
  signer.end();
  return signer.sign(binanceKeys.privateKey).toString("base64");
}

// --- fake provider HTTP ------------------------------------------------------

interface FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

type FakeHandler = (req: FakeRequest) => { status?: number; body: unknown } | null;

/** Minimal fetch stub returning real Response objects (adapters read .ok/.json/.text). */
function fakeFetch(handler: FakeHandler): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const hit = handler({ url, method, body });
    if (hit === null) return new Response("no route", { status: 404 });
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

interface WebhookRequest {
  readonly rawBody: string;
  readonly headers: Record<string, string>;
}

interface RoundTrip {
  readonly adapter: PaymentProviderAdapter;
  /** What the server persists: providerSessionId ?? transactionId. */
  readonly storedProviderRef: string;
  readonly webhook: WebhookRequest;
}

interface CryptoCase {
  readonly label: string;
  /** Adapters with no signature to verify (BitPay authenticates by fetch-back). */
  readonly unsigned?: boolean;
  run(txId: string): Promise<RoundTrip>;
}

function checkoutInput(txId: string) {
  return {
    transactionId: txId,
    tenantId: TENANT_ID,
    ownerId: OWNER_ID,
    amountMicros: USD_50_MICROS,
    currencyCode: "USD" as const,
  };
}

/** Build the Binance notification envelope + signed headers for the given data. */
function binanceWebhook(data: Record<string, unknown>, bizStatus: string, bizType = "PAY") {
  const rawBody = JSON.stringify({
    bizType,
    // Real bizId values overflow Number.MAX_SAFE_INTEGER, which is exactly why
    // Binance also sends bizIdStr; the adapter must prefer the string form.
    bizId: "29383937493038367292",
    bizIdStr: "29383937493038367292",
    bizStatus,
    data: JSON.stringify(data),
  });
  const timestamp = Date.now().toString();
  const nonce = "a".repeat(32);
  return {
    rawBody,
    headers: {
      [BINANCE_TIMESTAMP_HEADER]: timestamp,
      [BINANCE_NONCE_HEADER]: nonce,
      [BINANCE_SIGNATURE_HEADER]: signAsBinance(timestamp, nonce, rawBody),
    },
  };
}

function makeBinanceAdapter(onTradeNo: (tradeNo: string) => void): PaymentProviderAdapter {
  const fetcher = fakeFetch(({ url, body }) => {
    if (!url.includes("/binancepay/openapi/v3/order")) return null;
    const parsed = JSON.parse(body) as { merchantTradeNo: string };
    onTradeNo(parsed.merchantTradeNo);
    return {
      body: {
        status: "SUCCESS",
        code: "000000",
        data: {
          prepayId: "29383937493038367292",
          terminalType: "WEB",
          expireTime: Date.now() + 3_600_000,
          checkoutUrl: "https://pay.binance.com/en/checkout/e2e",
          qrcodeLink: "https://public.bnbstatic.com/qr/e2e.jpg",
          deeplink: "bnc://app.binance.com/payment/secpay/e2e",
        },
      },
    };
  });
  return createBinanceAdapter({
    apiKey: "binance-api-key-e2e",
    apiSecret: "binance-api-secret-e2e",
    webhookPublicKey: BINANCE_PUBLIC_PEM,
    returnUrl: "https://app.example/return",
    fetcher,
  });
}

const CRYPTO_CASES: readonly CryptoCase[] = [
  {
    label: "binance",
    async run(txId) {
      // The trade number is read off the outbound wire, never from the
      // adapter's return value — a wrong compaction fails here, not in prod.
      let sentTradeNo = "";
      const adapter = makeBinanceAdapter((tradeNo) => {
        sentTradeNo = tradeNo;
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId));
      // Binance rejects anything but <=32 alphanumeric chars (400201/400101).
      expect(sentTradeNo).toMatch(/^[0-9a-zA-Z]{1,32}$/);
      const webhook = binanceWebhook(
        {
          merchantTradeNo: sentTradeNo,
          totalFee: "50.00",
          currency: "USD",
          transactTime: Date.now(),
          transactionId: "P_BNB_E2E",
        },
        "PAY_SUCCESS",
      );
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook,
      };
    },
  },
  {
    label: "nowpayments",
    async run(txId) {
      let sentOrderId = "";
      const fetcher = fakeFetch(({ url, body }) => {
        if (!url.includes("/v1/invoice")) return null;
        sentOrderId = (JSON.parse(body) as { order_id: string }).order_id;
        return { body: { id: 4944017921, invoice_url: "https://nowpayments.io/invoice/e2e" } };
      });
      const adapter = createNowpaymentsAdapter({
        apiKey: "np-api-key-e2e",
        ipnSecret: NP_SECRET,
        fetcher,
        environment: "sandbox",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId));
      const payload = {
        payment_id: 4944017921,
        payment_status: "finished",
        order_id: sentOrderId,
        price_amount: 50,
        price_currency: "usd",
        pay_currency: "usdttrc20",
        actually_paid: 50,
      };
      const rawBody = JSON.stringify(payload);
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: {
          rawBody,
          headers: { [NP_SIGNATURE_HEADER]: computeNpSignature(canonicalize(payload), NP_SECRET) },
        },
      };
    },
  },
  {
    label: "cryptomus",
    async run(txId) {
      const uuid = "cm-uuid-e2e";
      let sentOrderId = "";
      const fetcher = fakeFetch(({ url, body }) => {
        if (!url.includes("/v1/payment")) return null;
        sentOrderId = (JSON.parse(body) as { order_id: string }).order_id;
        return {
          body: {
            state: 0,
            result: { uuid, order_id: sentOrderId, url: "https://pay.cryptomus.com/pay/e2e" },
          },
        };
      });
      const adapter = createCryptomusAdapter({
        merchantId: "merchant-uuid-e2e",
        paymentApiKey: CRYPTOMUS_KEY,
        fetcher,
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId));
      const payload = {
        type: "payment",
        uuid,
        order_id: sentOrderId,
        status: "paid",
        amount: "50.00",
        payment_amount_usd: "50.00",
        network: "tron",
        currency: "USDT",
      };
      // `sign` must come last: the verifier strips it and re-serializes the
      // rest in insertion order.
      const { sign } = computeCryptomusSign(payload, CRYPTOMUS_KEY);
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody: JSON.stringify({ ...payload, sign }), headers: {} },
      };
    },
  },
  {
    label: "bitpay",
    unsigned: true,
    async run(txId) {
      const invoiceId = "inv-e2e";
      let sentOrderId = "";
      const fetcher = fakeFetch(({ url, method, body }) => {
        if (method === "POST" && url.endsWith("/invoices")) {
          sentOrderId = (JSON.parse(body) as { orderId: string }).orderId;
          return {
            body: {
              data: {
                id: invoiceId,
                url: `https://test.bitpay.com/invoice?id=${invoiceId}`,
                expirationTime: Date.now() + 900_000,
              },
            },
          };
        }
        if (method === "GET" && url.includes(`/invoices/${invoiceId}`)) {
          // BitPay IPNs are unsigned — the authoritative state is fetched back.
          return {
            body: {
              data: {
                id: invoiceId,
                orderId: sentOrderId,
                status: "confirmed",
                price: 50,
                currency: "USD",
                amountPaid: 50,
              },
            },
          };
        }
        return null;
      });
      const adapter = createBitpayAdapter({
        apiToken: "pos-token-e2e",
        fetcher,
        environment: "sandbox",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId));
      const rawBody = JSON.stringify({
        event: { name: "invoice_confirmed" },
        data: { id: invoiceId },
      });
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody, headers: {} },
      };
    },
  },
  {
    label: "coinbase-commerce",
    async run(txId) {
      let sentReference = "";
      const fetcher = fakeFetch(({ url, body }) => {
        if (!url.includes("/charges")) return null;
        const parsed = JSON.parse(body) as { metadata: Record<string, string> };
        sentReference = parsed.metadata[PAYKIT_REFERENCE_METADATA_KEY] ?? "";
        return {
          body: {
            data: {
              id: "cb-charge-e2e",
              code: "E2ECODE",
              hosted_url: "https://commerce.coinbase.com/charges/E2ECODE",
            },
          },
        };
      });
      const adapter = createCoinbaseCommerceAdapter({
        apiKey: "cc-api-key-e2e",
        webhookSecret: COINBASE_SECRET,
        fetcher,
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId));
      const rawBody = JSON.stringify({
        event: {
          id: "cb-evt-e2e",
          type: "charge:confirmed",
          data: {
            id: "cb-charge-e2e",
            code: "E2ECODE",
            pricing: { local: { amount: "50.00", currency: "USD" } },
            metadata: { [PAYKIT_REFERENCE_METADATA_KEY]: sentReference },
            payments: [{ status: "CONFIRMED", value: { local: { amount: "50.00" } } }],
          },
        },
      });
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: {
          rawBody,
          headers: {
            [COINBASE_COMMERCE_SIGNATURE_HEADER]: computeCoinbaseCommerceSignature(
              rawBody,
              COINBASE_SECRET,
            ),
          },
        },
      };
    },
  },
];

/** Normalize a webhook the way the router does: resolveWebhook, else parse. */
async function normalize(
  adapter: PaymentProviderAdapter,
  webhook: WebhookRequest,
): Promise<NormalizedWebhookEvent | null> {
  if (adapter.resolveWebhook) return adapter.resolveWebhook(webhook.rawBody, webhook.headers);
  return adapter.parseWebhookPayload(webhook.rawBody, webhook.headers);
}

// ---------------------------------------------------------------------------
// Layer 1 — provider_ref round-trip + signature acceptance.
// ---------------------------------------------------------------------------

describe("crypto adapters: checkout → completed webhook provider_ref round-trip", () => {
  it.each(CRYPTO_CASES.map((c) => [c.label, c] as const))(
    "%s: the provider_ref stored at checkout is the one its completed webhook emits",
    async (_label, cryptoCase) => {
      const { adapter, storedProviderRef, webhook } = await cryptoCase.run(TX_ID);
      const evt = await normalize(adapter, webhook);

      expect(evt).not.toBeNull();
      const event = evt as NormalizedWebhookEvent;
      expect(event.type).toBe("payment.completed");
      // When this fails the webhook router finds no row, returns 200, and the
      // customer's payment never credits.
      expect(event.providerRef).toBe(storedProviderRef);
      expect(event.currencyCode).toBe("USD");
      expect(event.amountMicros).toBe(USD_50_MICROS.toString());
    },
  );

  it.each(CRYPTO_CASES.filter((c) => c.unsigned !== true).map((c) => [c.label, c] as const))(
    "%s: accepts its own signed completed webhook",
    async (_label, cryptoCase) => {
      const { adapter, webhook } = await cryptoCase.run(TX_ID);
      expect(adapter.verifyWebhookSignature(webhook.rawBody, webhook.headers)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Binance-specific behaviour that only exists on this adapter.
// ---------------------------------------------------------------------------

describe("binance: webhook signature and quarantine behaviour", () => {
  it("rejects a webhook whose body was tampered after signing", async () => {
    const adapter = makeBinanceAdapter(() => {});
    const webhook = binanceWebhook(
      { merchantTradeNo: TX_ID.replace(/-/g, ""), totalFee: "50.00", currency: "USD" },
      "PAY_SUCCESS",
    );
    // The inner `data` member is a JSON-encoded string, so quotes are escaped;
    // tamper the bare digits to actually change the raw bytes.
    const tampered = webhook.rawBody.replace("50.00", "5000.00");
    expect(tampered).not.toBe(webhook.rawBody);
    expect(adapter.verifyWebhookSignature(tampered, webhook.headers)).toBe(false);
  });

  it("quarantines a coin-denominated completion as payment.amount_mismatch", async () => {
    // A merchant not onboarded for USD pricing gets orders denominated in a
    // coin; totalFee is then a coin amount. Crediting "49.98 USDT" as $49.98
    // would be a wrong ledger write, so the adapter flags it instead.
    const adapter = makeBinanceAdapter(() => {});
    const webhook = binanceWebhook(
      { merchantTradeNo: TX_ID.replace(/-/g, ""), totalFee: "49.98", currency: "USDT" },
      "PAY_SUCCESS",
    );
    const event = adapter.parseWebhookPayload(webhook.rawBody, webhook.headers);
    expect(event?.type).toBe("payment.amount_mismatch");
    expect(event?.providerRef).toBe(TX_ID);
    expect(event?.currencyCode).toBe("USDT");
  });

  it("normalizes REFUND_SUCCESS to payment.refunded with the USD refund amount", async () => {
    const adapter = makeBinanceAdapter(() => {});
    const webhook = binanceWebhook(
      {
        merchantTradeNo: TX_ID.replace(/-/g, ""),
        totalFee: "50.00",
        currency: "USD",
        refundInfo: {
          refundRequestId: "refund-req-e2e",
          prepayId: "29383937493038367292",
          orderAmount: "50.00",
          refundAmount: "20.00",
          refundedAmount: "20.00",
        },
      },
      "REFUND_SUCCESS",
      "PAY_REFUND",
    );
    expect(adapter.verifyWebhookSignature(webhook.rawBody, webhook.headers)).toBe(true);
    const event = adapter.parseWebhookPayload(webhook.rawBody, webhook.headers);
    expect(event?.type).toBe("payment.refunded");
    expect(event?.providerRef).toBe(TX_ID);
    expect(event?.refundAmountMicros).toBe("20000000");
    // The refund keys on prepayId at Binance; it must surface for persistence.
    expect(event?.providerPaymentId).toBe("29383937493038367292");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the same webhooks through the real router.
// ---------------------------------------------------------------------------

interface TxRow {
  transactionId: string;
  tenantId: string;
  ownerId: string;
  provider: string;
  amountMicros: string;
  currencyCode: string;
  status: string;
  providerRef: string;
  metadataJson: Record<string, unknown>;
}

/**
 * Collect the bound parameter values from a drizzle where-clause so the stub can
 * answer the router's lookup honestly instead of returning a row unconditionally
 * — a stub that always returns the row would hide the very bug under test.
 */
function whereParams(node: unknown, seen = new Set<unknown>(), out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  const obj = node as Record<string, unknown>;
  if ("value" in obj && (typeof obj.value === "string" || typeof obj.value === "number")) {
    out.push(obj.value);
  }
  for (const key of ["queryChunks", "chunks", "left", "right", "params"]) {
    const child = obj[key];
    if (Array.isArray(child)) for (const c of child) whereParams(c, seen, out);
    else if (child) whereParams(child, seen, out);
  }
  return out;
}

function makeDb(row: TxRow) {
  // Two lookups must not be conflated: the credit path selects by
  // (provider, provider_ref) — two bound params — while the post-commit re-read
  // selects by transaction_id — one bound param.
  const matches = (params: readonly unknown[]): boolean => {
    if (params.length >= 2) {
      return params[0] === row.provider && params[1] === row.providerRef;
    }
    return params.length === 1 && params[0] === row.transactionId;
  };
  const selectChain = () => {
    let params: unknown[] = [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (w: unknown) => {
      params = whereParams(w);
      return chain;
    };
    chain.for = () => chain;
    chain.limit = async () => (matches(params) ? [row] : []);
    return chain;
  };
  const updateChain = () => ({ set: () => ({ where: async () => undefined }) });
  const client = {
    select: selectChain,
    update: updateChain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: selectChain, update: updateChain }),
  };
  return client as never;
}

function buildApp(adapter: PaymentProviderAdapter, row: TxRow) {
  const registry = {
    get: (id: string) => (id === adapter.id ? adapter : null),
    list: () => [adapter],
    register: () => {},
  } as unknown as ProviderRegistry;
  return buildWebhookRouter({ db: makeDb(row), registry, events: {} });
}

beforeEach(() => {
  mAppend.mockReset().mockResolvedValue({ inserted: true });
  mApplyDelta.mockReset().mockResolvedValue(undefined);
  mUpdateStatus.mockReset().mockImplementation(async (_tx, txId: string, status: string) => ({
    transactionId: txId,
    status,
  }));
});

describe("crypto completed webhooks through the real router", () => {
  it.each(CRYPTO_CASES.map((c) => [c.label, c] as const))(
    "%s: a matching provider_ref credits the ledger and completes the transaction",
    async (label, cryptoCase) => {
      const { adapter, storedProviderRef, webhook } = await cryptoCase.run(TX_ID);
      const event = (await normalize(adapter, webhook)) as NormalizedWebhookEvent;
      const row: TxRow = {
        transactionId: TX_ID,
        tenantId: TENANT_ID,
        ownerId: OWNER_ID,
        provider: adapter.id,
        amountMicros: USD_50_MICROS.toString(),
        currencyCode: "USD",
        status: "pending",
        providerRef: storedProviderRef,
        metadataJson: {},
      };

      const app = buildApp(adapter, row);
      const res = await app.request(
        new Request(`http://localhost/${adapter.id}`, {
          method: "POST",
          body: webhook.rawBody,
          headers: webhook.headers,
        }),
      );

      expect(res.status).toBe(200);
      expect(mAppend, `${label} did not credit`).toHaveBeenCalledTimes(1);
      expect(mAppend.mock.calls[0]?.[1]).toMatchObject({
        tenantId: TENANT_ID,
        ownerId: OWNER_ID,
        entryType: "credit",
        provider: adapter.id,
        // The ledger idempotency key is the same provider_ref the lookup used.
        sourceId: event.providerRef,
        currencyCode: "USD",
      });
      expect(mApplyDelta).toHaveBeenCalledTimes(1);
      expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "completed");
    },
  );

  it.each(CRYPTO_CASES.map((c) => [c.label, c] as const))(
    "%s: a provider_ref the webhook never emits silently credits nothing",
    async (label, cryptoCase) => {
      const { adapter, storedProviderRef, webhook } = await cryptoCase.run(TX_ID);
      const row: TxRow = {
        transactionId: TX_ID,
        tenantId: TENANT_ID,
        ownerId: OWNER_ID,
        provider: adapter.id,
        amountMicros: USD_50_MICROS.toString(),
        currencyCode: "USD",
        status: "pending",
        providerRef: `provider-side-id-not-${storedProviderRef}`,
        metadataJson: {},
      };

      const app = buildApp(adapter, row);
      const res = await app.request(
        new Request(`http://localhost/${adapter.id}`, {
          method: "POST",
          body: webhook.rawBody,
          headers: webhook.headers,
        }),
      );

      // 200 with no ledger write is what makes this failure mode invisible in
      // production: the provider stops retrying and nothing surfaces.
      expect(res.status).toBe(200);
      expect(mAppend, `${label} credited on a mismatched provider_ref`).not.toHaveBeenCalled();
      expect(mApplyDelta).not.toHaveBeenCalled();
      expect(mUpdateStatus).not.toHaveBeenCalled();
    },
  );
});
