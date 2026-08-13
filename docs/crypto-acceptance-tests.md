# Crypto adapters acceptance tests

Living checklist for taking the five crypto adapters (Binance Pay, NowPayments,
Cryptomus, BitPay, Coinbase Commerce) to verified-in-production status. Mirrors
plan "Hoàn thiện + verify thanh toán quốc tế (crypto) cho paykit".

Two gates per provider:

1. **CI gate (no credentials)** — mocked-provider tests that pin the wire
   contract each adapter was built against. These run on every push.
2. **Live gate (credentials required)** — a real sandbox/production
   transaction driven through `e2e/live-verify/`. Until a provider's live gate
   passes, its README row keeps the "not yet verified end-to-end" flag and the
   `UNVERIFIED AGAINST LIVE API` comments stay in the adapter source.

## CI gate — mocked providers (runs today)

- [x] Checkout → completed-webhook `provider_ref` round-trip for all 5 crypto
      adapters (`e2e/consumer-app/tests/crypto-adapters-roundtrip.test.ts`;
      NowPayments/Cryptomus/BitPay/Coinbase also covered per-adapter in
      `packages/server/__tests__/checkout-webhook-roundtrip-e2e.test.ts`)
- [x] Binance `merchantTradeNo` hyphen-compact at checkout expands back to the
      stored UUID on the webhook (the only adapter that transforms the id)
- [x] Binance RSA-SHA256 webhook signature verifies; a tampered body is rejected
- [x] Binance coin-denominated completion (non-USD `currency`) quarantines as
      `payment.amount_mismatch` — never credited as dollars
- [x] Binance `REFUND_SUCCESS` normalizes to `payment.refunded` with a USD
      refund amount and surfaces `prepayId` as `providerPaymentId`
- [x] Signed completed webhooks accepted for NowPayments (HMAC-SHA512 over
      canonical JSON), Cryptomus (MD5 over PHP-escaped JSON), Coinbase Commerce
      (HMAC-SHA256); BitPay authenticates by fetch-back (unsigned IPN)
- [x] Through the real webhook router: a matching `provider_ref` credits the
      ledger exactly once and completes the transaction; a mismatched one
      credits nothing (all 5 adapters)
- [x] BitPay merchant-facade ECDSA signer round-trips locally
      (`packages/bitpay-adapter/__tests__/merchant-signer.test.ts`)
- [x] Service mode wires all 5 crypto adapters from env, including BitPay with
      an optional `BITPAY_MERCHANT_PRIVATE_KEY`
      (`packages/service/__tests__/adapters-from-env-bitpay.test.ts`)

## Live gate — per provider (needs your credentials)

Run each item with the harness: `pnpm --filter @paykit-e2e/live-verify serve`
in one terminal, `... verify --provider <id>` in another, behind a cloudflared
or ngrok tunnel. Setup per provider: `docs/sandbox-setup-<provider>.md`.

### Binance Pay (`docs/sandbox-setup-binance.md`)

- [ ] Host clock drift < 1s (`pnpm --filter @paykit-e2e/live-verify clock-check`)
- [ ] `certPublic` fetched (`... binance-cert`) and set as `BINANCE_WEBHOOK_PUBLIC_KEY`
- [ ] Small live checkout completes: webhook signature verifies, ledger credits
- [ ] Merchant USD-pricing onboarding confirmed — OR the USDT-denominated
      completion quarantines as designed (test whichever branch your account is in)
- [ ] Live refund: `refundStatus` enum observed matches
      INITIAL/PENDING/CANCELLED/REFUNDED; `REFUND_SUCCESS` webhook debits the ledger
- [ ] Remove `UNVERIFIED AGAINST LIVE API` comments in
      `packages/binance-adapter/` + drop the README flag

### NowPayments (`docs/sandbox-setup-nowpayments.md`)

- [ ] Sandbox checkout per chain: `usdtbsc`, `usdttrc20`, `usdterc20`,
      `usdtmatic` + customer-choice mode
- [ ] IPN signature verifies on a real delivery
- [ ] Refund resolves `pending_webhook` → `payment_status=refunded`
- [ ] `fetchTransactions` paging works against the sandbox ledger
- [ ] Drop the README flag

### Cryptomus (`docs/sandbox-setup-cryptomus.md`)

- [ ] Checkout with pinned `network=bsc/tron/eth/polygon` renders the right chain
- [ ] MD5 sign verifies on a real webhook (PHP-escaping path)
- [ ] `refund_paid` webhook resolves the refund
- [ ] Cursor pagination of `fetchTransactions` works
- [ ] Drop the README flag

### BitPay (`docs/sandbox-setup-bitpay.md`)

- [ ] test.bitpay.com POS token created; invoice checkout + fetch-back credits
- [ ] Merchant key approved; first signed request accepted (401 here means the
      identity/signature pair was rejected — see `merchant-signer.ts` header)
- [ ] Live refund via `POST /refunds`; refund-confirmation webhook resolves it
      (shape pinned in `refund-webhook.ts` gets confirmed or corrected)
- [ ] Drop the README "not yet sandbox-verified" flag

### Coinbase Commerce (`docs/sandbox-setup-coinbase-commerce.md`)

- [ ] Real charge: `charge:confirmed` webhook verifies and credits
- [ ] Event-name unknowns confirmed: `charge:delayed` / `charge:resolved`
      arrive as spelled; `pricing.local` present; UNDERPAID timeline `context`
- [ ] Manual-refund runbook executed once end-to-end
      (`docs/refund-flows.md` — Coinbase section)
- [ ] Drop the README flag

## GA gate

A provider's row in the README matrix loses its "not yet verified" flag only
when every box in its live section above is checked. The CI gate alone is not
sufficient — it pins the contract the adapter was built against, not the
contract the provider actually implements.
