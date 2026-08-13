# BitPay Sandbox Setup

BitPay has a full sandbox at **test.bitpay.com** (separate account from
production). Two credentials exist because BitPay splits its API into facades:

- **POS token** — invoice create + fetch-back (`GET /invoices/:id`). No crypto.
- **Merchant facade** — refunds + reconciliation listing. Every request is
  ECDSA-signed (secp256k1) with a merchant private key.

## Step 1 — Register a test merchant

1. Sign up at https://test.bitpay.com (sandbox — no real KYC).
2. Dashboard → *Payment Tools → API Tokens* → create a token with the
   **point-of-sale** capability → `BITPAY_API_TOKEN`.

## Step 2 — Merchant-facade key (for refunds + reconciliation)

Generate a secp256k1 keypair and pair it with a **merchant**-capability token:

```bash
# Generate a key (PEM works directly with paykit):
openssl ecparam -name secp256k1 -genkey -noout -out bitpay-merchant.pem
```

Pairing: create a *merchant* token in the dashboard and approve the pairing
request made with this key (the official BitPay SDK's pairing flow, or the
dashboard's approval screen). Then:

```
BITPAY_MERCHANT_PRIVATE_KEY=<contents of bitpay-merchant.pem, or 64-hex key>
```

paykit ships `createNodeMerchantSigner` (`@xeko-git-1/paykit-bitpay`) which
implements BitPay's signing scheme (x-identity = compressed public key hex,
x-signature = DER ECDSA hex over SHA256(url+body)) with node:crypto only. In
embedded mode you may instead inject any `BitpayMerchantSigner` (e.g. one backed
by the official SDK or a KMS).

Without the key, checkout and webhook credit still work; refunds return
`NO_MERCHANT_SIGNER` and reconciliation throws (deliberately — an empty listing
would read as "nothing settled").

## Step 3 — Env

```
BITPAY_API_TOKEN=<pos token>
BITPAY_ENVIRONMENT=sandbox
BITPAY_MERCHANT_PRIVATE_KEY=<pem or hex — optional but needed for refunds>
```

The notification URL is sent per-invoice (`notificationURL`), derived from
`PUBLIC_BASE_URL` in the live-verify harness (`…/webhooks/bitpay`).

## Step 4 — Trust model reminder

BitPay webhooks are **unsigned**. The adapter never trusts the IPN body: it
re-fetches the invoice (POS token) or the refund (merchant facade) from BitPay
and acts on that authoritative response only. A webhook that cannot be
authenticated is skipped — BitPay retries on non-2xx.

## Step 5 — Verification checklist

```bash
pnpm --filter @paykit-e2e/live-verify verify -- bitpay --amount 5 --refund
```

Sandbox invoices are payable with testnet coins (the invoice page shows the
options) or via the sandbox's payment simulation.

Record each item in `docs/crypto-live-acceptance-tests.md`:

- [ ] Invoice create succeeds (POS token, no signing); hosted page opens
- [ ] Invoice IPN arrives → fetch-back `GET /invoices/:id` succeeds → ledger
      credits the exact USD `price` on `confirmed`/`complete`
- [ ] `orderId` round-trip: `provider_ref` = paykit transactionId matches
- [ ] Refund: POST /refunds accepted with the node signer (x-identity /
      x-signature accepted by BitPay — this is the signer's first live proof)
- [ ] Refund IPN arrives; classifier routes it to `GET /refunds/:id` (NOT
      /invoices) — record the real envelope (`event.code`/`event.name` values)
- [ ] Observe the real refund `status` enum. The adapter treats only
      success/succeeded/completed/complete as settled — flag any other spelling
      BitPay actually uses (see SETTLED_REFUND_STATUSES in
      `packages/bitpay-adapter/src/refund-webhook.ts`)
- [ ] Ledger debits exactly once when the refund settles
- [ ] Reconciliation: `fetchTransactions` (merchant facade) lists the paid
      invoice for the window

After all boxes pass, update the refund-webhook.ts "FIELD SHAPES ARE
DOCUMENTED, NOT LIVE-VERIFIED" note, `docs/refund-flows.md`, and the README
provider matrix.
