# Cryptomus Setup

Cryptomus has no separate sandbox host — verification runs against the
production API (`api.cryptomus.com`) with a real merchant. Small USDT amounts
on a cheap chain (BEP20/Polygon) keep the cost of a run to cents.

## Step 1 — Register a merchant

1. Sign up at https://cryptomus.com and complete merchant verification.
2. Create a merchant ("business") in the dashboard. Note the **merchant UUID**
   (`CRYPTOMUS_MERCHANT_ID`).
3. Under the merchant's *Settings → API*, generate the **Payment API key**
   (`CRYPTOMUS_PAYMENT_API_KEY`). This one key signs REST requests AND verifies
   inbound webhooks — there is no separate IPN secret.

## Step 2 — Env

```
CRYPTOMUS_MERCHANT_ID=<merchant uuid>
CRYPTOMUS_PAYMENT_API_KEY=<payment api key>
# Pin coin/chain, or leave empty for customer choice on the pay page:
#   CRYPTOMUS_TO_CURRENCY=USDT
#   CRYPTOMUS_NETWORK= bsc (BEP20) | tron (TRC20) | eth (ERC20) | polygon
CRYPTOMUS_TO_CURRENCY=
CRYPTOMUS_NETWORK=
```

The callback URL is sent per-invoice (`url_callback`), derived from
`PUBLIC_BASE_URL` in the live-verify harness.

## Step 3 — Signature model (what a failed webhook means)

Every REST request and every webhook carries
`sign = MD5( base64( JSON body ) + PAYMENT_API_KEY )`, with PHP-style escaped
slashes (`\/`) in the JSON — the adapter's verifier reproduces that quirk
(`packages/cryptomus-adapter/src/webhook-verifier.ts`). A webhook rejected with
401 therefore almost always means the JSON re-serialization diverged from
Cryptomus' PHP form; capture the raw body when reporting it.

Cryptomus also has a dashboard tool to resend/test webhooks against a URL — use
it for quick signature checks before paying a real invoice.

## Step 4 — Verification checklist

```bash
pnpm --filter @paykit-e2e/live-verify verify -- cryptomus --amount 5 --refund
```

Record each item in `docs/crypto-live-acceptance-tests.md`:

- [ ] Invoice create succeeds; hosted pay page opens
- [ ] Webhook arrives; MD5 sign verifies against the raw body (PHP escaping)
- [ ] Webhook keys on `order_id` = paykit transactionId; ledger credits the
      exact USD amount
- [ ] Multi-chain: repeat with `CRYPTOMUS_NETWORK` = `bsc`, `tron`, `eth`,
      `polygon` (or at least the chains you will enable in production), and once
      unpinned
- [ ] Cryptomus `uuid` is persisted in metadata (refunds/audit need it)
- [ ] Refund: POST /v1/payment/refund accepted → state `pending_webhook`;
      the later `refund_paid` webhook debits the ledger exactly once
- [ ] `wrong_amount` (underpaid) and expiry flows quarantine/expire instead of
      crediting
- [ ] Reconciliation: POST /v1/payment/list returns the paid invoice; cursor
      paging terminates (short-page rule)

After all boxes pass, update the README provider matrix and
`docs/integration-guide.md` §6.
