# Binance Pay Setup (live — no sandbox)

Binance Pay has **no public sandbox**. A trial merchant account exists but is
granted only by Binance support on request. Every verification run below hits
the LIVE API with real funds — use the smallest amounts possible ($1).

## Step 1 — Merchant account + API keys

1. Register a merchant at https://merchant.binance.com (business KYB required;
   an ordinary Binance account is enough to *pay* an order, not to receive).
2. In the merchant dashboard, create an API identity:
   - `apiKey` — sent as `BinancePay-Certificate-SN` on every request
   - `apiSecret` — HMAC-SHA512 key for request signatures
3. **USD pricing check (critical):** ask Binance whether your merchant is
   onboarded for fiat (USD) order pricing. The adapter always sends
   `currency: "USD"`. A non-onboarded merchant gets order-create rejections; if
   you instead price in USDT, the webhook's `totalFee` is a coin amount and
   paykit **quarantines** the payment rather than crediting coins as dollars.
   Record which case applies in `docs/crypto-live-acceptance-tests.md`.

## Step 2 — Clock sync (before anything else)

Binance accepts a request only within ~1 second of its own clock; otherwise
every call fails with `400003`.

```bash
pnpm --filter @paykit-e2e/live-verify clock-check
```

If drift exceeds ~500 ms, sync (`sudo sntp -sS time.apple.com` on macOS,
`chronyc makestep` on Linux) and re-run.

## Step 3 — Webhook public key

The adapter verifies webhooks with Binance's RSA public key (`certPublic`),
fetched once at setup — not per webhook (see the WEBHOOK KEY DESIGN note in
`packages/binance-adapter/src/index.ts`):

```bash
BINANCE_API_KEY=... BINANCE_API_SECRET=... \
  pnpm --filter @paykit-e2e/live-verify binance-cert
```

Paste the printed PEM into `BINANCE_WEBHOOK_PUBLIC_KEY`. When Binance rotates
certificates, the adapter accepts an array — configure both keys during the
overlap.

## Step 4 — Env

```
BINANCE_API_KEY=<from dashboard>
BINANCE_API_SECRET=<from dashboard>
BINANCE_WEBHOOK_PUBLIC_KEY=<certPublic PEM from step 3>
```

The live-verify harness derives the per-order webhook URL from
`PUBLIC_BASE_URL` (`…/webhooks/binance`). In service mode set
`BINANCE_WEBHOOK_URL` (or configure the URL on the merchant platform).

## Step 5 — Verification checklist

Run through the harness (`e2e/live-verify/README.md`):

```bash
pnpm --filter @paykit-e2e/live-verify verify -- binance --amount 1 --refund
```

Confirm, and record each item in `docs/crypto-live-acceptance-tests.md`:

- [ ] Order create succeeds with `currency: "USD"` (merchant onboarded), OR is
      rejected (record the error code) — decides the quarantine question above
- [ ] `checkoutUrl` opens; payment completes from a Binance wallet
- [ ] Webhook arrives; RSA signature verifies with the configured `certPublic`
- [ ] `merchantTradeNo` round-trips: the hyphen-compacted transactionId matches
      the stored `provider_ref` and the ledger credits the exact USD amount
- [ ] `prepayId` is persisted as `providerPaymentId` on payment.completed
      (required for refunds — check the transaction row's metadata)
- [ ] Refund accepted; observe the real `refundStatus` value in the response
      (spec says INITIAL/PENDING/CANCELLED/REFUNDED — flag any other value)
- [ ] `REFUND_SUCCESS` webhook arrives and the ledger debits once
- [ ] A deliberately bad refund (e.g. over-amount) returns one of the terminal
      codes in `TERMINAL_REFUND_ERROR_CODES` (`packages/binance-adapter/src/adapter.ts`)
      and the transaction does NOT get stuck in `refund_pending_webhook`

After all boxes pass, update the `UNVERIFIED AGAINST LIVE API` header comment in
`packages/binance-adapter/src/adapter.ts` and the README provider matrix.

## Known constraints

- Reconciliation: Binance Pay has no merchant-wide list API, so the adapter
  declares `canListTransactions: false` — the reconciler skips it by design.
- Requests must be NTP-accurate (step 2) on every host that runs the adapter,
  including production.
