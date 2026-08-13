/**
 * Live-verify driver — one command per provider run:
 *
 *   pnpm --filter @paykit-e2e/live-verify verify -- nowpayments --amount 5
 *   pnpm --filter @paykit-e2e/live-verify verify -- binance --amount 1 --refund
 *
 * Flow (against the local server started by `serve`):
 *   1. POST /api/billing/checkout/<provider>  → prints the pay URL / QR
 *   2. Operator pays on the provider page (real coins on live rails!)
 *   3. Polls GET /api/billing/payments until the transaction is `completed`
 *      (webhook arrived through the tunnel and the ledger was credited)
 *   4. Prints the balance delta
 *   5. --refund: POST /admin/refund for the full amount, then polls until
 *      `refunded` (crypto providers resolve refunds via a later webhook —
 *      NowPayments documents up to 24h, so the poll timeout is generous and
 *      interruptible; re-running with --resume <txId> --refund-wait continues).
 *
 * Every observation that confirms or contradicts an adapter's spec-derived
 * assumption should be recorded in docs/crypto-live-acceptance-tests.md.
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.LIVE_VERIFY_BASE ?? "http://localhost:4242";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "live-verify-admin";
const PAYMENT_TIMEOUT_MS = Number.parseInt(process.env.PAYMENT_TIMEOUT_MS ?? "1800000", 10); // 30 min
const REFUND_TIMEOUT_MS = Number.parseInt(process.env.REFUND_TIMEOUT_MS ?? "1800000", 10);
const POLL_INTERVAL_MS = 5_000;

interface PaymentRow {
  readonly transactionId: string;
  readonly provider: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  readonly status: string;
  readonly providerRef: string | null;
  readonly createdAt: string;
}

function usage(): never {
  console.error(
    "Usage: verify -- <provider> [--amount <usd>] [--refund] [--resume <transactionId>] [--refund-wait]\n" +
      "  provider: nowpayments | cryptomus | binance | bitpay | coinbase-commerce",
  );
  process.exit(1);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: { data?: T; error?: { code: string; message: string } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`HTTP ${res.status} from ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(`HTTP ${res.status} ${json.error?.code ?? ""}: ${json.error?.message ?? text}`);
  }
  return json.data as T;
}

async function getPayment(transactionId: string): Promise<PaymentRow | undefined> {
  const { payments } = await api<{ payments: PaymentRow[] }>("/api/billing/payments?limit=100");
  return payments.find((p) => p.transactionId === transactionId);
}

async function getBalances(): Promise<unknown> {
  return api<unknown>("/api/billing/balance");
}

async function pollUntil(
  transactionId: string,
  done: (status: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<PaymentRow> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const row = await getPayment(transactionId);
    if (row) {
      if (row.status !== lastStatus) {
        lastStatus = row.status;
        console.log(`  [${new Date().toISOString()}] status = ${row.status}`);
      }
      if (done(row.status)) return row;
      if (row.status === "failed" || row.status === "expired") {
        throw new Error(`transaction reached terminal status '${row.status}' while ${label}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `timed out ${label} after ${Math.round(timeoutMs / 60000)} min (last status: ${lastStatus || "row not found"}).\n` +
      `Re-attach later with: verify -- <provider> --resume ${transactionId}${label.includes("refund") ? " --refund-wait" : ""}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const provider = argv[0];
  if (!provider || provider.startsWith("--")) usage();

  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const resumeId = value("resume");
  let transactionId: string;
  let amountMicros: string;

  if (resumeId) {
    const row = await getPayment(resumeId);
    if (!row) throw new Error(`transaction ${resumeId} not found`);
    transactionId = row.transactionId;
    amountMicros = row.amountMicros;
    console.log(`Resuming ${transactionId} (status: ${row.status})`);
    if (row.status !== "completed" && row.status !== "refunded" && !flag("refund-wait")) {
      await pollUntil(transactionId, (s) => s === "completed", PAYMENT_TIMEOUT_MS, "waiting for payment");
    }
  } else {
    const amountUsd = Number.parseFloat(value("amount") ?? "5");
    if (!Number.isFinite(amountUsd) || amountUsd < 1) {
      throw new Error("--amount must be >= 1 (checkout route enforces min $1)");
    }

    console.log(`Balances before: ${JSON.stringify(await getBalances())}`);

    const checkout = await api<{
      transactionId: string;
      webUrl: string;
      qrUrl?: string;
      mobileDeeplink?: string;
      expiresAt: string;
    }>(`/api/billing/checkout/${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ amountUsd }),
    });
    transactionId = checkout.transactionId;
    amountMicros = String(BigInt(Math.round(amountUsd * 1_000_000)));

    console.log("\n=== CHECKOUT CREATED ===");
    console.log(`  transactionId: ${checkout.transactionId}`);
    console.log(`  pay here:      ${checkout.webUrl}`);
    if (checkout.qrUrl) console.log(`  QR:            ${checkout.qrUrl}`);
    if (checkout.mobileDeeplink) console.log(`  deeplink:      ${checkout.mobileDeeplink}`);
    console.log(`  expires:       ${checkout.expiresAt}`);
    console.log("\nComplete the payment now. Waiting for the provider webhook…\n");

    await pollUntil(transactionId, (s) => s === "completed", PAYMENT_TIMEOUT_MS, "waiting for payment");
    console.log("\n=== PAYMENT CREDITED ===");
    console.log(`Balances after: ${JSON.stringify(await getBalances())}`);
  }

  if (flag("refund") || flag("refund-wait")) {
    if (!flag("refund-wait")) {
      console.log("\n=== REQUESTING REFUND (full amount) ===");
      const refund = await api<unknown>("/admin/refund", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
          "X-Admin-Secret": ADMIN_SECRET,
        },
        body: JSON.stringify({
          transactionId,
          amountMicros,
          reason: "live-verify refund check",
        }),
      });
      console.log(`  refund response: ${JSON.stringify(refund)}`);
    }
    console.log("Waiting for the refund webhook (crypto providers may take hours)…");
    await pollUntil(transactionId, (s) => s === "refunded", REFUND_TIMEOUT_MS, "waiting for refund");
    console.log("\n=== REFUND SETTLED ===");
    console.log(`Balances after refund: ${JSON.stringify(await getBalances())}`);
  }

  console.log("\nDone. Record the observed behaviour in docs/crypto-live-acceptance-tests.md.");
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
