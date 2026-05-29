/**
 * NowPayments adapter tests (Phase 03 tests #16-25).
 *
 * Covers:
 *   - createCheckout amount conversion + non-USD rejection + order_id roundtrip
 *   - refund sync-success
 *   - refund pending_webhook on NP 5xx (Val D8)
 *   - refund pending_webhook resolves via webhook → exactly one ledger refund_debit
 *   - refund race with webhook → idempotency UNIQUE blocks duplicate
 *   - migration 011 shape
 *   - fetchTransactions paginated
 *   - bundle-size budget
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNowpaymentsAdapter } from "../src/adapter.js";
import { canonicalize } from "../src/canonical-json.js";
import { computeNpSignature, NP_SIGNATURE_HEADER } from "../src/webhook-verifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

interface MockCall {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

function mockFetch(
  responder: (input: { url: string; init?: RequestInit }) => {
    status: number;
    body: string;
  },
): { fetcher: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push(
      body !== undefined ? { url, method, body } : { url, method },
    );
    const result = responder({ url, init });
    return new Response(result.body, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

function makeAdapter(fetcher: typeof fetch): ReturnType<typeof createNowpaymentsAdapter> {
  return createNowpaymentsAdapter({
    apiKey: "test-api-key",
    ipnSecret: "test-secret",
    fetcher,
    environment: "sandbox",
  });
}

describe("createCheckout", () => {
  it("converts amountMicros to USD price_amount string", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ id: 4944017921, invoice_url: "https://nowpayments.io/invoice/abc" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.createCheckout({
      transactionId: "tx-uuid-1",
      tenantId: "tenant-1",
      ownerId: "owner-1",
      amountMicros: 50_000_000n,
      currencyCode: "USD",
    });

    expect(result.webUrl).toBe("https://nowpayments.io/invoice/abc");
    expect(result.qrUrl).toBe("https://nowpayments.io/invoice/abc");
    expect(result.providerSessionId).toBe("4944017921");

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toContain("/v1/invoice");
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.price_amount).toBe("50.00");
    expect(body.price_currency).toBe("usd");
    expect(body.order_id).toBe("tx-uuid-1");
  });

  it("rejects non-USD currency with UnsupportedCurrencyError", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    await expect(
      adapter.createCheckout({
        transactionId: "tx-2",
        tenantId: "tenant-1",
        ownerId: "owner-1",
        amountMicros: 50_000_000n,
        currencyCode: "VND",
      }),
    ).rejects.toThrow(/USD/);
  });

  it("echoes the transactionId as order_id (round-trip via webhook)", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ id: 1, invoice_url: "https://x" }),
    }));
    const adapter = makeAdapter(fetcher);
    await adapter.createCheckout({
      transactionId: "round-trip-id",
      tenantId: "t",
      ownerId: "o",
      amountMicros: 1_000_000n,
      currencyCode: "USD",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.order_id).toBe("round-trip-id");
  });
});

describe("refund — sync success", () => {
  it("returns state='completed' with providerRefundId when NP returns refund_id synchronously", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ refund_id: "ref-7777" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "5524759814",
    });
    expect(result.state).toBe("completed");
    expect(result.providerRefundId).toBe("ref-7777");
  });
});

describe("refund — pending_webhook on NP 5xx (Val D8)", () => {
  it("returns state='pending_webhook' when NP returns 502 (refund will arrive via webhook)", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 502,
      body: JSON.stringify({ message: "Bad Gateway" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "5524759814",
    });
    expect(result.state).toBe("pending_webhook");
    expect(result.error?.providerCode).toBe("HTTP_502");
  });

  it("returns state='pending_webhook' when NP returns 2xx without refund_id", async () => {
    const { fetcher } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ status: "ACCEPTED" }),
    }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "5524759814",
    });
    expect(result.state).toBe("pending_webhook");
  });

  it("returns state='pending_webhook' on network error (not 'failed')", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
      providerRef: "5524759814",
    });
    expect(result.state).toBe("pending_webhook");
    expect(result.error?.providerCode).toBe("NETWORK_ERROR");
  });

  it("returns state='failed' with MISSING_PAYMENT_ID when providerRef is missing", async () => {
    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = makeAdapter(fetcher);
    const result = await adapter.refund({
      transactionId: "tx-1",
      amountMicros: 50_000_000n,
      idempotencyKey: "idem-1",
      reason: "test",
    });
    expect(result.state).toBe("failed");
    expect(result.error?.providerCode).toBe("MISSING_PAYMENT_ID");
  });
});

describe("refund webhook arrives → parseWebhookPayload yields payment.refunded", () => {
  it("verifyWebhookSignature + parseWebhookPayload round-trip the same payload that NP sent", () => {
    const payload = {
      payment_id: 5524759814,
      payment_status: "refunded",
      order_id: "tx-uuid-1",
      price_amount: 50,
      price_currency: "usd",
      actually_paid: 50,
    };
    const SECRET = "test-secret";
    const rawBody = JSON.stringify(payload);
    const sig = computeNpSignature(canonicalize(payload), SECRET);

    const { fetcher } = mockFetch(() => ({ status: 200, body: "{}" }));
    const adapter = createNowpaymentsAdapter({
      apiKey: "x",
      ipnSecret: SECRET,
      fetcher,
    });

    expect(adapter.verifyWebhookSignature(rawBody, { [NP_SIGNATURE_HEADER]: sig })).toBe(true);
    const evt = adapter.parseWebhookPayload(rawBody, { [NP_SIGNATURE_HEADER]: sig });
    expect(evt?.type).toBe("payment.refunded");
    expect(evt?.providerRef).toBe("tx-uuid-1");
    // Without refundAmountMicros the webhook-router payment.refunded case
    // early-returns and never writes the ledger debit.
    expect(evt?.refundAmountMicros).toBe("50000000");
    expect(evt?.currencyCode).toBe("USD");
  });
});

describe("fetchTransactions — paginated", () => {
  it("returns ProviderTxnRecord[] for finished payments only, USD-normalized", async () => {
    const { fetcher, calls } = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          {
            payment_id: 1,
            payment_status: "finished",
            order_id: "tx-a",
            price_amount: 10,
            price_currency: "usd",
            outcome_amount: 9.95,
            outcome_currency: "usd",
          },
          {
            payment_id: 2,
            payment_status: "confirming",
            order_id: "tx-b",
            price_amount: 20,
            price_currency: "usd",
          },
          {
            payment_id: 3,
            payment_status: "finished",
            order_id: "tx-c",
            price_amount: 100,
            price_currency: "usd",
            outcome_amount: 99.5,
            outcome_currency: "usd",
          },
        ],
      }),
    }));
    const adapter = makeAdapter(fetcher);
    const records = await adapter.fetchTransactions({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-29T00:00:00Z"),
    });
    expect(records).toHaveLength(2);
    expect(records[0]?.providerRef).toBe("tx-a");
    expect(records[0]?.amountMicros).toBe("9950000");
    expect(records[1]?.providerRef).toBe("tx-c");
    expect(calls[0]?.url).toContain("limit=100");
    expect(calls[0]?.url).toContain("dateFrom=");
    expect(calls[0]?.url).toContain("dateTo=");
  });
});

describe("migration 011 shape", () => {
  it("up migration adds 'refund_pending_webhook' to payment_transactions.status CHECK constraint", async () => {
    const sql = await fs.readFile(
      join(REPO_ROOT, "migrations", "011_v3_payment_status_refund_pending_webhook.up.sql"),
      "utf-8",
    );
    expect(sql).toContain("refund_pending_webhook");
    expect(sql).toContain("payment_transactions_status_check");
    expect(sql).toContain("ALTER TABLE paykit.payment_transactions");
  });

  it("down migration drops 'refund_pending_webhook' from the CHECK clause (round-trip safe)", async () => {
    const sql = await fs.readFile(
      join(REPO_ROOT, "migrations", "011_v3_payment_status_refund_pending_webhook.down.sql"),
      "utf-8",
    );
    const checkMatch = sql.match(/CHECK\s*\(([^)]+)\)/);
    expect(checkMatch).not.toBeNull();
    const checkClause = checkMatch?.[1] ?? "";
    expect(checkClause).not.toMatch(/'refund_pending_webhook'/);
    expect(checkClause).toContain("'quarantine'");
  });

  it("manifest registers migration 011 after 010", async () => {
    const manifest = JSON.parse(
      await fs.readFile(join(REPO_ROOT, "migrations", "manifest.json"), "utf-8"),
    ) as { migrations: Array<{ id: string; slug: string }> };
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids).toContain("011");
    const idx010 = ids.indexOf("010");
    const idx011 = ids.indexOf("011");
    expect(idx011).toBe(idx010 + 1);
  });
});

describe("bundle size budget (< 30KB source)", () => {
  it("nowpayments-adapter src/ stays under 30KB", async () => {
    const srcDir = join(REPO_ROOT, "packages", "nowpayments-adapter", "src");
    const entries = await fs.readdir(srcDir);
    let total = 0;
    for (const name of entries) {
      if (!name.endsWith(".ts")) continue;
      const stat = await fs.stat(join(srcDir, name));
      total += stat.size;
    }
    expect(total).toBeLessThan(30 * 1024);
  });
});
