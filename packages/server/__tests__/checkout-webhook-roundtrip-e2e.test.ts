import { createHmac } from "node:crypto";
/**
 * Checkout → webhook provider_ref round-trip, for every shipped adapter.
 *
 * The webhook router finds the payment row with
 *   WHERE provider = adapter.id AND provider_ref = evt.providerRef
 * and the server stores, at checkout time,
 *   provider_ref = checkoutResult.providerSessionId ?? transactionId
 *
 * Those two ends are written in different packages and were only ever tested
 * apart. When an adapter returns one identifier at checkout but its webhook
 * keys the payment on another, the lookup matches no row, the router returns
 * 200, and the payment never credits — the customer pays and the balance stays
 * zero. No unit test failed when that happened, because no test connected the
 * two ends. This file connects them.
 *
 * Layer 1 drives each adapter's REAL createCheckout against a fake provider,
 * captures the identifier the provider received (or generated), then builds the
 * provider's own payment.completed webhook from THAT identifier and asserts the
 * normalized event keys on the same value the server stored. The provider-side
 * identifier is always read back from the wire — the outbound create request or
 * the provider's response — never copied from the adapter's return value, so an
 * adapter that returns the wrong field fails here instead of passing trivially.
 *
 * Layer 2 sends the full webhook through the real buildWebhookRouter and asserts
 * a matching provider_ref credits the ledger and a mismatched one does not. The
 * mismatch case is the money-losing failure mode, pinned as a test.
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
} from "@xeko-git-1/paykit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Stripe SDK stub ---------------------------------------------------------
// Stripe's adapter talks through the SDK, not global fetch, so the SDK is the
// fake-provider seam. `lastSessionId` records what the provider generated at
// checkout so the webhook can echo it back the way Stripe does.
const stripeState = vi.hoisted(() => ({ lastSessionId: "" }));

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: vi.fn(async (opts: { metadata?: Record<string, string> }) => {
          stripeState.lastSessionId = "cs_test_roundtrip";
          return {
            id: stripeState.lastSessionId,
            url: "https://checkout.stripe.com/c/pay/cs_test_roundtrip",
            metadata: opts.metadata,
          };
        }),
        retrieve: vi.fn(),
        list: vi.fn(),
      },
    };
    refunds = { create: vi.fn() };
    webhooks = {
      constructEvent: vi.fn((payload: string, sig: string, secret: string) => {
        if (sig === `sig_${secret}`) return JSON.parse(payload);
        throw new Error("invalid signature");
      }),
    };
  }
  return { default: MockStripe };
});

// The router records every delivery in the inbox before processing it, so this
// stands in for that repo. The factory is async so the shared helper can be pulled
// in from inside it — a hoisted factory cannot reach a top-level import.
vi.mock("@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js", async () => {
  const { inboxRepoMock } = await import("./helpers/webhook-inbox-repo-mock.js");
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
  findActiveByTransaction,
  markCompleted,
} from "@xeko-git-1/paykit-auth-core/db/repos/pending-refund.repo.js";
import { buildWebhookRouter } from "../src/routes/webhooks/webhook-router.js";

import {
  COINBASE_COMMERCE_SIGNATURE_HEADER,
  PAYKIT_REFERENCE_METADATA_KEY,
  computeCoinbaseCommerceSignature,
  createCoinbaseCommerceAdapter,
} from "@xeko-git-1/paykit-coinbase-commerce";
import { createBitpayAdapter } from "../../bitpay-adapter/src/adapter.js";
import { createCryptomusAdapter } from "../../cryptomus-adapter/src/adapter.js";
import { computeCryptomusSign } from "../../cryptomus-adapter/src/webhook-verifier.js";
import { createMomoAdapter } from "../../momo-adapter/src/adapter.js";
import { buildIpnCanonical, sign as momoSign } from "../../momo-adapter/src/signature.js";
import { createNowpaymentsAdapter } from "../../nowpayments-adapter/src/adapter.js";
import { canonicalize } from "../../nowpayments-adapter/src/canonical-json.js";
import {
  NP_SIGNATURE_HEADER,
  computeNpSignature,
} from "../../nowpayments-adapter/src/webhook-verifier.js";
import { createSepayAdapter } from "../../sepay-adapter/src/adapter.js";
import { createStripeAdapter } from "../../stripe-adapter/src/adapter.js";
import { createVnpayAdapter } from "../../vnpay-adapter/src/adapter.js";
import { signParams } from "../../vnpay-adapter/src/signature.js";
import { createZaloPayAdapter } from "../../zalopay-adapter/src/adapter.js";
import { signWithKey2 } from "../../zalopay-adapter/src/signature.js";

const mAppend = appendLedgerEntryIdempotent as ReturnType<typeof vi.fn>;
const mApplyDelta = applyDelta as ReturnType<typeof vi.fn>;
const mFindActive = findActiveByTransaction as ReturnType<typeof vi.fn>;
const mMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mUpdateStatus = updateTransactionStatus as ReturnType<typeof vi.fn>;

const TX_ID = "a0000000-0000-4000-8000-000000000042";
const TENANT_ID = "tenant-rt";
const OWNER_ID = "owner-rt";

/** $50.00 — 1 USD = 1_000_000 micros. */
const USD_50_MICROS = 50_000_000n;
/** 500,000 VND — 1 VND = 1_000_000 micros. */
const VND_500K_MICROS = 500_000n * 1_000_000n;

const SEPAY_SECRET = "sepay_secret_rt";
const VNPAY_SECRET = "vnpay_secret_rt";
const MOMO_SECRET = "momo_secret_rt";
const ZALOPAY_KEY2 = "zalopay_key2_rt";
const NP_SECRET = "np_ipn_secret_rt";
const CRYPTOMUS_KEY = "cryptomus_key_rt";
const COINBASE_COMMERCE_SECRET = "cc-whsec-roundtrip";
const STRIPE_WEBHOOK_SECRET = "whsec_rt";

// --- fake provider HTTP -----------------------------------------------------

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

/** Run `fn` with global fetch swapped — for adapters with no fetch injection point. */
async function withGlobalFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
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

interface AdapterCase {
  readonly label: string;
  readonly currencyCode: "USD" | "VND";
  readonly amountMicros: bigint;
  /** Adapters with no signature to verify (BitPay authenticates by fetch-back). */
  readonly unsigned?: boolean;
  run(txId: string): Promise<RoundTrip>;
}

function checkoutInput(txId: string, amountMicros: bigint, currencyCode: string) {
  return {
    transactionId: txId,
    tenantId: TENANT_ID,
    ownerId: OWNER_ID,
    amountMicros,
    currencyCode,
  };
}

// One entry per shipped adapter. Adding a future adapter is one entry.
const ADAPTER_CASES: readonly AdapterCase[] = [
  {
    label: "stripe",
    currencyCode: "USD",
    amountMicros: USD_50_MICROS,
    async run(txId) {
      const adapter = createStripeAdapter({
        secretKey: "sk_test_x",
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, USD_50_MICROS, "USD"));
      // Stripe generates the session id; the webhook echoes the id the API
      // returned, so read it from the provider side, not from the adapter.
      const providerSideId = stripeState.lastSessionId;
      const rawBody = JSON.stringify({
        id: "evt_rt_stripe",
        type: "checkout.session.completed",
        data: {
          object: {
            id: providerSideId,
            payment_status: "paid",
            amount_total: 5000,
            currency: "usd",
            metadata: { paykitTransactionId: txId, tenantId: TENANT_ID, ownerId: OWNER_ID },
          },
        },
      });
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody, headers: { "stripe-signature": `sig_${STRIPE_WEBHOOK_SECRET}` } },
      };
    },
  },
  {
    label: "sepay",
    currencyCode: "VND",
    amountMicros: VND_500K_MICROS,
    async run(txId) {
      const adapter = createSepayAdapter({
        apiKey: "ak",
        secretKey: SEPAY_SECRET,
        accountNumber: "0123456789",
        accountName: "PAYKIT TEST",
        bankBin: "970422",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, VND_500K_MICROS, "VND"));
      // SePay matches a bank transfer by the memo printed on the VietQR. The
      // payer's bank echoes that memo, so take it from the QR the customer scans.
      const memo = new URL(checkout.qrUrl ?? "").searchParams.get("addInfo") ?? "";
      const rawBody = JSON.stringify({
        id: "evt-rt-sepay",
        transferType: "in",
        transferAmount: 500_000,
        content: memo,
        description: "",
        referenceCode: "ref-rt",
      });
      const signature = createHmac("sha256", SEPAY_SECRET).update(rawBody).digest("hex");
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody, headers: { "x-sepay-signature": signature } },
      };
    },
  },
  {
    label: "vnpay",
    currencyCode: "VND",
    amountMicros: VND_500K_MICROS,
    async run(txId) {
      const adapter = createVnpayAdapter({
        tmnCode: "TEST_TMN",
        hashSecret: VNPAY_SECRET,
        returnUrl: "https://app.example/return",
        ipnUrl: "https://app.example/ipn",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, VND_500K_MICROS, "VND"));
      // VNPay echoes the vnp_TxnRef it was handed in the redirect URL.
      const txnRef = new URL(checkout.webUrl).searchParams.get("vnp_TxnRef") ?? "";
      const params: Record<string, string> = {
        vnp_TmnCode: "TEST_TMN",
        vnp_TxnRef: txnRef,
        vnp_Amount: "50000000",
        vnp_ResponseCode: "00",
        vnp_TransactionNo: "99",
        vnp_TransactionStatus: "00",
        vnp_BankCode: "NCB",
        vnp_OrderInfo: "PaykitRoundTrip",
      };
      params.vnp_SecureHash = signParams(params, VNPAY_SECRET);
      const rawBody = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody, headers: { "content-type": "application/x-www-form-urlencoded" } },
      };
    },
  },
  {
    label: "momo",
    currencyCode: "VND",
    amountMicros: VND_500K_MICROS,
    async run(txId) {
      let sentOrderId = "";
      const stub = fakeFetch(({ url, body }) => {
        if (!url.includes("/v2/gateway/api/create")) return null;
        sentOrderId = (JSON.parse(body) as { orderId: string }).orderId;
        return {
          body: {
            resultCode: 0,
            message: "Successful.",
            payUrl: "https://test-payment.momo.vn/v2/gateway/pay?t=rt",
            deeplink: "momo://app?action=payWithApp&sid=rt",
            qrCodeUrl: "https://test-payment.momo.vn/v2/gateway/pay/qr?t=rt",
          },
        };
      });
      const adapter = createMomoAdapter({
        partnerCode: "MOMOTEST",
        accessKey: "ak_test",
        secretKey: MOMO_SECRET,
        returnUrl: "https://app.example/return",
        ipnUrl: "https://app.example/ipn",
      });
      const checkout = await withGlobalFetch(stub, () =>
        adapter.createCheckout(checkoutInput(txId, VND_500K_MICROS, "VND")),
      );
      // MoMo's IPN echoes the orderId it received on the create call.
      const payload: Record<string, string | number> = {
        partnerCode: "MOMOTEST",
        orderId: sentOrderId,
        requestId: "req-rt",
        amount: "500000",
        resultCode: 0,
        transId: "trans-rt",
      };
      const canonicalParams: Record<string, string> = {};
      for (const [k, v] of Object.entries(payload)) canonicalParams[k] = String(v);
      const signature = momoSign(buildIpnCanonical(canonicalParams), MOMO_SECRET);
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody: JSON.stringify({ ...payload, signature }), headers: {} },
      };
    },
  },
  {
    label: "zalopay",
    currencyCode: "VND",
    amountMicros: VND_500K_MICROS,
    async run(txId) {
      let sentAppTransId = "";
      const stub = fakeFetch(({ url, body }) => {
        if (!url.includes("/v2/create")) return null;
        sentAppTransId = (JSON.parse(body) as { app_trans_id: string }).app_trans_id;
        return {
          body: {
            return_code: 1,
            return_message: "Giao dich thanh cong",
            order_url: "https://sbgateway.zalopay.vn/pay?order=rt",
            zp_trans_token: "tok-rt",
            qr_code: "00020101-rt",
          },
        };
      });
      const adapter = createZaloPayAdapter({
        appId: "2553",
        key1: "zalopay_key1_rt",
        key2: ZALOPAY_KEY2,
        returnUrl: "https://app.example/return",
        callbackUrl: "https://app.example/callback",
      });
      const checkout = await withGlobalFetch(stub, () =>
        adapter.createCheckout(checkoutInput(txId, VND_500K_MICROS, "VND")),
      );
      // ZaloPay's callback echoes the app_trans_id the create call registered.
      const data = JSON.stringify({
        app_id: 2553,
        app_trans_id: sentAppTransId,
        amount: 500_000,
        zp_trans_id: "zp-rt",
        server_time: Date.now(),
      });
      const rawBody = JSON.stringify({ data, mac: signWithKey2(data, ZALOPAY_KEY2), type: 1 });
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody, headers: {} },
      };
    },
  },
  {
    label: "nowpayments",
    currencyCode: "USD",
    amountMicros: USD_50_MICROS,
    async run(txId) {
      let sentOrderId = "";
      const fetcher = fakeFetch(({ url, body }) => {
        if (!url.includes("/v1/invoice")) return null;
        sentOrderId = (JSON.parse(body) as { order_id: string }).order_id;
        // The NP invoice id differs from order_id on purpose: returning it as
        // providerSessionId is exactly the bug this file guards against.
        return { body: { id: 4944017921, invoice_url: "https://nowpayments.io/invoice/rt" } };
      });
      const adapter = createNowpaymentsAdapter({
        apiKey: "test-api-key",
        ipnSecret: NP_SECRET,
        fetcher,
        environment: "sandbox",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, USD_50_MICROS, "USD"));
      const payload = {
        payment_id: 4944017921,
        payment_status: "finished",
        order_id: sentOrderId,
        price_amount: 50,
        price_currency: "usd",
        actually_paid: 50,
      };
      const rawBody = JSON.stringify(payload);
      const sig = computeNpSignature(canonicalize(payload), NP_SECRET);
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody, headers: { [NP_SIGNATURE_HEADER]: sig } },
      };
    },
  },
  {
    label: "bitpay",
    currencyCode: "USD",
    amountMicros: USD_50_MICROS,
    unsigned: true,
    async run(txId) {
      const invoiceId = "inv-rt";
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
          // Authoritative invoice fetched back — keyed on orderId, not invoice id.
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
        apiToken: "pos-token",
        fetcher,
        environment: "sandbox",
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, USD_50_MICROS, "USD"));
      // BitPay does not sign IPNs — the POSTed body only names the invoice.
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
    currencyCode: "USD",
    amountMicros: USD_50_MICROS,
    async run(txId) {
      let sentReference = "";
      const fetcher = fakeFetch(({ url, body }) => {
        if (!url.includes("/charges")) return null;
        const parsed = JSON.parse(body) as { metadata: Record<string, string> };
        sentReference = parsed.metadata[PAYKIT_REFERENCE_METADATA_KEY] ?? "";
        return {
          body: {
            data: {
              id: "cb-charge-rt",
              code: "RTCODE",
              hosted_url: "https://commerce.coinbase.com/charges/RTCODE",
            },
          },
        };
      });
      const adapter = createCoinbaseCommerceAdapter({
        apiKey: "cc-api-key-rt",
        webhookSecret: COINBASE_COMMERCE_SECRET,
        fetcher,
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, USD_50_MICROS, "USD"));
      const rawBody = JSON.stringify({
        event: {
          id: "cb-evt-rt",
          type: "charge:confirmed",
          data: {
            id: "cb-charge-rt",
            code: "RTCODE",
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
              COINBASE_COMMERCE_SECRET,
            ),
          },
        },
      };
    },
  },
  {
    label: "cryptomus",
    currencyCode: "USD",
    amountMicros: USD_50_MICROS,
    async run(txId) {
      const uuid = "cm-uuid-rt";
      let sentOrderId = "";
      const fetcher = fakeFetch(({ url, body }) => {
        if (!url.includes("/v1/payment")) return null;
        sentOrderId = (JSON.parse(body) as { order_id: string }).order_id;
        return {
          body: {
            state: 0,
            result: { uuid, order_id: sentOrderId, url: "https://pay.cryptomus.com/pay/rt" },
          },
        };
      });
      const adapter = createCryptomusAdapter({
        merchantId: "merchant-uid-rt",
        paymentApiKey: CRYPTOMUS_KEY,
        fetcher,
      });
      const checkout = await adapter.createCheckout(checkoutInput(txId, USD_50_MICROS, "USD"));
      const payload = {
        type: "payment",
        uuid,
        order_id: sentOrderId,
        status: "paid",
        amount: "50.00",
        payment_amount_usd: "50.00",
      };
      // `sign` must come last: the verifier strips it and re-serializes the rest
      // in insertion order.
      const { sign } = computeCryptomusSign(payload, CRYPTOMUS_KEY);
      return {
        adapter,
        storedProviderRef: checkout.providerSessionId ?? txId,
        webhook: { rawBody: JSON.stringify({ ...payload, sign }), headers: {} },
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

describe("checkout → webhook provider_ref round-trip (every shipped adapter)", () => {
  it.each(ADAPTER_CASES.map((c) => [c.label, c] as const))(
    "%s: the provider_ref stored at checkout is the one its completed webhook emits",
    async (_label, adapterCase) => {
      const { adapter, storedProviderRef, webhook } = await adapterCase.run(TX_ID);
      const evt = await normalize(adapter, webhook);

      expect(evt).not.toBeNull();
      const event = evt as NormalizedWebhookEvent;
      expect(event.type).toBe("payment.completed");

      // The invariant. When this fails the webhook router finds no row, returns
      // 200, and the customer's payment never credits.
      expect(event.providerRef).toBe(storedProviderRef);
      expect(storedProviderRef.length).toBeGreaterThan(0);
    },
  );

  it.each(ADAPTER_CASES.filter((c) => c.unsigned !== true).map((c) => [c.label, c] as const))(
    "%s: accepts its own signed completed webhook",
    async (_label, adapterCase) => {
      const { adapter, webhook } = await adapterCase.run(TX_ID);
      expect(adapter.verifyWebhookSignature(webhook.rawBody, webhook.headers)).toBe(true);
    },
  );

  it("covers every adapter the registry can ship", () => {
    expect(ADAPTER_CASES.map((c) => c.label).sort()).toEqual([
      "bitpay",
      "coinbase-commerce",
      "cryptomus",
      "momo",
      "nowpayments",
      "sepay",
      "stripe",
      "vnpay",
      "zalopay",
    ]);
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
  // The router issues two different lookups and they must not be conflated: the
  // credit path selects by (provider, provider_ref) — two bound params — while
  // the post-commit re-read selects by transaction_id — one bound param. Several
  // adapters legitimately store provider_ref = transactionId, so matching on
  // "does any param equal a column value" would let the provider_ref lookup
  // succeed via the transactionId, masking exactly the mismatch under test.
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
  mFindActive.mockReset().mockResolvedValue([]);
  mMarkCompleted.mockReset().mockResolvedValue(undefined);
  mUpdateStatus.mockReset().mockImplementation(async (_tx, txId: string, status: string) => ({
    transactionId: txId,
    status,
  }));
});

/** nowpayments (crypto), sepay (bank transfer), stripe (card rail). */
const ROUTED_CASES = ADAPTER_CASES.filter((c) =>
  ["nowpayments", "sepay", "stripe"].includes(c.label),
);

describe("completed webhook through the real router — credit depends on the provider_ref match", () => {
  it.each(ROUTED_CASES.map((c) => [c.label, c] as const))(
    "%s: a matching provider_ref credits the ledger and the balance",
    async (label, adapterCase) => {
      const { adapter, storedProviderRef, webhook } = await adapterCase.run(TX_ID);
      const event = (await normalize(adapter, webhook)) as NormalizedWebhookEvent;
      const row: TxRow = {
        transactionId: TX_ID,
        tenantId: TENANT_ID,
        ownerId: OWNER_ID,
        provider: adapter.id,
        amountMicros: adapterCase.amountMicros.toString(),
        currencyCode: adapterCase.currencyCode,
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
      expect(mAppend.mock.calls[0][1]).toMatchObject({
        tenantId: TENANT_ID,
        ownerId: OWNER_ID,
        entryType: "credit",
        provider: adapter.id,
        // The ledger idempotency key is the same provider_ref the lookup used.
        sourceId: event.providerRef,
        currencyCode: adapterCase.currencyCode,
      });
      expect(mApplyDelta).toHaveBeenCalledTimes(1);
      expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), TX_ID, "completed");
    },
  );

  it.each(ROUTED_CASES.map((c) => [c.label, c] as const))(
    "%s: a provider_ref the webhook never emits silently credits nothing",
    async (label, adapterCase) => {
      const { adapter, storedProviderRef, webhook } = await adapterCase.run(TX_ID);
      // The regression: checkout stored an identifier the webhook does not key
      // on (NowPayments stored invoice_id, BitPay stored the invoice id). The
      // row exists and the customer has paid, but the lookup misses it.
      const row: TxRow = {
        transactionId: TX_ID,
        tenantId: TENANT_ID,
        ownerId: OWNER_ID,
        provider: adapter.id,
        amountMicros: adapterCase.amountMicros.toString(),
        currencyCode: adapterCase.currencyCode,
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

      // 200 with no ledger write is what made this invisible in production:
      // the provider stops retrying and nothing surfaces as an error.
      expect(res.status).toBe(200);
      expect(mAppend, `${label} credited on a mismatched provider_ref`).not.toHaveBeenCalled();
      expect(mApplyDelta).not.toHaveBeenCalled();
      expect(mUpdateStatus).not.toHaveBeenCalled();
    },
  );
});
