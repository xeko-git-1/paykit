# NowPayments Sandbox Setup

NowPayments has a **public sandbox** (separate account and API host from
production) — the easiest crypto provider to verify first.

## Step 1 — Register a sandbox account

1. Visit https://account.sandbox.nowpayments.io and sign up (email only, no KYC
   for sandbox).
2. Add a payout wallet when prompted (any address works in sandbox).
3. Under *Settings → Payments → API keys*, generate the **API key**.
4. Under *Settings → Payments → Instant payment notifications*, generate the
   **IPN secret** — it is separate from the API key; the adapter needs both.

For production: https://account.nowpayments.io (KYC/KYB required for fiat
settlement; crypto-to-crypto works after basic verification).

## Step 2 — Env

```
NOWPAYMENTS_API_KEY=<sandbox api key>
NOWPAYMENTS_IPN_SECRET=<sandbox ipn secret>
NOWPAYMENTS_ENVIRONMENT=sandbox
# Multi-chain USDT — leave empty for customer choice, or pin one chain:
#   usdtbsc   → BEP20 (BNB Smart Chain)
#   usdttrc20 → TRC20 (Tron)
#   usdterc20 → ERC20 (Ethereum)
#   usdtmatic → Polygon
NOWPAYMENTS_PAY_CURRENCY=
```

The IPN callback URL is sent per-invoice by the adapter (`ipn_callback_url`),
derived from `PUBLIC_BASE_URL` in the live-verify harness — no dashboard
webhook configuration is needed.

## Step 3 — Sandbox payment simulation

Sandbox invoices are not paid with real coins: open the invoice URL, and use the
sandbox's *mark as paid* control (or POST to the sandbox payment status
endpoint) to walk the payment through `waiting → confirming → finished`. Each
transition fires an IPN.

## Step 4 — Verification checklist

```bash
pnpm --filter @paykit-e2e/live-verify verify -- nowpayments --amount 5 --refund
```

Record each item in `docs/crypto-live-acceptance-tests.md`:

- [ ] Invoice create succeeds; `invoice_url` opens
- [ ] IPN arrives; HMAC-SHA512 signature over sorted-key JSON verifies
      (`x-nowpayments-sig` — the adapter's canonical-json implementation)
- [ ] IPN keys on `order_id` = paykit transactionId; ledger credits the exact
      USD `price_amount` (NOT the coin amount)
- [ ] Multi-chain: repeat once per pinned chain — `usdtbsc`, `usdttrc20`,
      `usdterc20`, `usdtmatic` — and once unpinned (customer picks on the page)
- [ ] `payment_id` from the IPN is persisted (refunds key on it)
- [ ] Refund: REST call returns either `refund_id` (state `completed`) or
      accepted-without-id (state `pending_webhook`); record which one sandbox does
- [ ] Refund IPN (`payment_status=refunded`) arrives and the ledger debits once
- [ ] Underpaid / expired flows: let an invoice expire, confirm the transaction
      moves to `expired` and nothing credits
- [ ] Reconciliation: `fetchTransactions` lists the finished payment for the
      window (drive >100 payments only if paging needs proving; otherwise code
      review of the short-page terminator stands)

After all boxes pass, update the README provider matrix ("not yet
sandbox-verified" note) and the flag in `docs/integration-guide.md` §6.

## Production switch

Set `NOWPAYMENTS_ENVIRONMENT=production` with production keys. Re-verify at
least one small live payment — sandbox does not exercise real chain
confirmation times or the production IPN infrastructure.
