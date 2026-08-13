# @paykit-e2e/live-verify

Harness for verifying the crypto adapters (NowPayments, Cryptomus, Binance Pay,
BitPay, Coinbase Commerce) against **real provider APIs**. The adapters ship
unit-tested against fakes only; this package is how the "not yet verified
end-to-end" flags in the README get removed, one provider at a time.

The per-provider registration + verification checklists live in
`docs/sandbox-setup-<provider>.md`. Record every run's outcome in
`docs/crypto-live-acceptance-tests.md`.

## One-time setup

```bash
# 1. Postgres + schema (repo root)
docker compose up -d postgres migrate

# 2. Install workspace deps
pnpm install

# 3. Copy env and fill the provider(s) you are verifying
cp e2e/live-verify/.env.example e2e/live-verify/.env
```

## Per-session setup

```bash
# 1. Public tunnel so providers can deliver webhooks
cloudflared tunnel --url http://localhost:4242
# → note the printed https://<random>.trycloudflare.com URL

# 2. Load env + tunnel URL, then boot the server
cd e2e/live-verify
set -a; source .env; set +a
export PUBLIC_BASE_URL=https://<random>.trycloudflare.com
pnpm serve
```

Note: a fresh `cloudflared --url` tunnel gets a new hostname every run. That is
fine for NowPayments / Cryptomus / Binance Pay / BitPay (the webhook URL is sent
per-checkout), but Coinbase Commerce takes its webhook URL from dashboard
settings — update it there when the tunnel URL changes, or use a named tunnel.

## Running a verification

```bash
# Payment only (amount in USD, min 1):
pnpm verify -- nowpayments --amount 5

# Payment then full refund:
pnpm verify -- cryptomus --amount 5 --refund

# Crypto refunds can take hours; re-attach to a pending one later:
pnpm verify -- nowpayments --resume <transactionId> --refund-wait
```

The script prints the hosted checkout URL — pay it from your wallet/account —
then polls the local API until the webhook credits the ledger, and (with
`--refund`) until the refund webhook debits it back.

## Binance Pay extras

Binance Pay has **no sandbox**: every check runs against the live API with real
funds. Two helper commands must pass before the first run:

```bash
pnpm clock-check    # Binance rejects requests outside ~1s of its clock (400003)
pnpm binance-cert   # fetches certPublic → BINANCE_WEBHOOK_PUBLIC_KEY
```

## What "verified" means per provider

- checkout URL opens and accepts payment
- webhook arrives, signature verifies, ledger credits the exact USD amount
- refund request is accepted and the refund webhook debits the ledger
  (Coinbase Commerce has no refund API — expect HTTP 501 from /admin/refund,
  then follow the ledger-adjustment runbook in docs/refund-flows.md)
- for adapters with `fetchTransactions`: a reconciliation window lists the paid
  transaction (run the worker or call the adapter directly)
