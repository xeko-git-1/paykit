/**
 * Fetch Binance Pay's webhook public key (`certPublic`) — the one-time setup
 * step the adapter requires before any webhook can be verified (see the
 * WEBHOOK KEY DESIGN note in @xeko-git-1/paykit-binance).
 *
 * Usage:
 *   BINANCE_API_KEY=... BINANCE_API_SECRET=... pnpm --filter @paykit-e2e/live-verify binance-cert
 *
 * Prints each certificate's serial + PEM. Paste the PEM into
 * BINANCE_WEBHOOK_PUBLIC_KEY (the adapter also accepts bare base64).
 */
import { randomBytes } from "node:crypto";
import { generateNonce, signRequest } from "@xeko-git-1/paykit-binance";

const API_BASE = "https://bpay.binanceapi.com";

async function main(): Promise<void> {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error("Set BINANCE_API_KEY and BINANCE_API_SECRET first.");
    process.exit(1);
  }

  const body = JSON.stringify({});
  const timestamp = Date.now().toString();
  const nonce = generateNonce(randomBytes);

  const res = await fetch(`${API_BASE}/binancepay/openapi/certificates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BinancePay-Timestamp": timestamp,
      "BinancePay-Nonce": nonce,
      "BinancePay-Certificate-SN": apiKey,
      "BinancePay-Signature": signRequest(timestamp, nonce, body, apiSecret),
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text) as {
    status?: string;
    code?: string;
    data?: ReadonlyArray<{ certSerial?: string; certPublic?: string }>;
    errorMessage?: string;
  };
  if (json.status !== "SUCCESS" || !json.data) {
    // 400003 here means the host clock is off — run `pnpm clock-check` first.
    throw new Error(`Binance rejected the request: ${json.code ?? "?"} ${json.errorMessage ?? text}`);
  }

  for (const cert of json.data) {
    console.log(`\ncertSerial: ${cert.certSerial ?? "(none)"}`);
    console.log(`certPublic:\n${cert.certPublic ?? "(none)"}`);
  }
  console.log(
    "\nSet BINANCE_WEBHOOK_PUBLIC_KEY to the certPublic value above (keep the PEM markers).",
  );
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
