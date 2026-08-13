# Refund Flows — Per-Provider Capabilities

V1.5 cross-provider refund endpoint: `POST /admin/billing/refund` with required `Idempotency-Key` header.

## Per-provider matrix

| Provider | Full refund | Partial | Refund window | Sync vs async | Notes |
|---|---|---|---|---|---|
| Stripe | ✅ | ✅ | 180 days | sync | Stripe Refund API |
| SePay | ❌ | ❌ | n/a | n/a | Bank transfer one-way; manual via `/admin/billing/ledger/adjust` |
| VNPay | ✅ | ✅ | 365 days | sync | VNPay merchant_webapi /transaction with `vnp_TransactionType=02` (full) or `=03` (partial) |
| Momo | ✅ | ✅ | 180 days | sync | /v2/gateway/api/refund with idempotent requestId |
| ZaloPay | ✅ | ✅ | 90 days | **2-step async** | Returns PROCESSING → reconciler polls until completed/failed |

## Refund states (paykit-side)

| State | Trigger | Ledger entry written? | Admin response |
|---|---|---|---|
| `completed` | Provider confirmed sync (Stripe / VNPay / Momo / ZaloPay return_code=1) | YES (`entry_type='refund'`, negative amount) | 200 with `entryId` |
| `pending` | ZaloPay return_code=3 (PROCESSING) | NO yet — `pending_refunds` row instead | 200 with `pendingId`, "awaiting confirmation" |
| `failed` | Provider rejected (over-window, already-refunded, etc.) | NO | 502 with provider code |
| `unsupported` | SePay (no API) | NO | 501 with `alternativeAction: '/admin/billing/ledger/adjust'` |

## Pending-webhook refunds (V3 — NowPayments, BitPay)

Some crypto providers process refunds asynchronously: the adapter POSTs a refund request, but confirmation arrives later via webhook rather than in the HTTP response.

| State | Trigger | Ledger entry written? | Admin response |
|---|---|---|---|
| `pending_webhook` | Adapter returns `state: 'pending_webhook'` (NP 4xx/5xx or accepted-but-not-yet-processed) | NO — deferred until webhook | 202 Accepted with `pendingId`, "Refund processing — awaiting confirmation" |

**Flow:**

1. Admin calls `POST /admin/billing/refund` → adapter returns `{state: 'pending_webhook'}`
2. Server writes `payment_transactions.status = 'refund_pending_webhook'` (migration 011 enum extension) — NOT `failed`
3. Provider webhook fires `payment.refunded` (≤24h) → `appendLedgerEntryIdempotent` writes exactly one `refund` debit entry (UNIQUE on `provider` + `sourceId` + `entry_type`); status flips to `refunded`
4. If webhook never arrives within 24h (configurable via `PAYKIT_REFUND_WEBHOOK_TIMEOUT_HOURS` in service mode) → the background sweeper reports it: raises `paykit_refund_webhook_overdue_total{provider}`, logs the transaction, and it appears in `GET /admin/refunds/overdue-webhooks` (the operator queue; `overdueAt` says whether the sweeper already fired). The sweeper never resolves the refund itself — whether the money moved is a question only the provider can answer, so the operator asks the provider and settles via `/admin/billing/ledger/adjust`.

**Race protection (RT F10):** Both the admin sync-success path and the webhook `refunded` path use `appendLedgerEntryIdempotent`. Whichever fires second gets `{inserted: false}` and skips `applyDelta` — exactly one ledger entry regardless of timing.

**Providers using this state:**

- **NowPayments** (`@xeko-git-1/paykit-nowpayments`) — signed IPN (HMAC-SHA512); refund IPN resolves the ledger debit + flips status to `refunded`.
- **BitPay** (`@xeko-git-1/paykit-bitpay`) — adapter shipped. BitPay does NOT sign webhooks, so authentication is **fetch-back** (`GET /invoices/:id`) via the adapter's async `resolveWebhook` hook rather than a signature check. Refund requires a merchant ECDSA signer: inject your own `BitpayMerchantSigner`, or use the packaged `createNodeMerchantSigner(privateKey)` (node:crypto secp256k1, mirrors the official SDK's scheme — in service mode this is wired from `BITPAY_MERCHANT_PRIVATE_KEY`). The refund returns `pending_webhook`; the refund IPN is resolved by fetch-back (`GET /refunds/:id` then the owning invoice) and writes the ledger debit for **settled** refunds only. The refund `status` enum and IPN envelope are **not yet sandbox-verified** (see `docs/sandbox-setup-bitpay.md` checklist) — until a live run confirms them, watch the first refunds and fall back to manual reconcile via `/admin/billing/ledger/adjust` if the debit does not land.

## Cumulative refund logic

Paykit tracks total refunded per transaction = SUM of `refund` ledger entries on that tx. Refund call rejected if `requested + already_refunded > original`.

Example: $10 charge, 2 refunds of $3 each = $6 refunded. Third refund of $5 → rejected (would exceed $10 total).

## Idempotency

`Idempotency-Key` header is **required** (red-team F3 fix — no free-text-reason key).

- Same key + different body → returns first attempt's result (paykit doesn't update)
- Each adapter ALSO honors the key against the provider (Stripe: `idempotencyKey` param; Momo: `requestId`; ZaloPay: `m_refund_id`)
- Recommended: generate UUID per refund attempt, retry with same UUID on network failure

## Pending refunds (ZaloPay PROCESSING)

When ZaloPay returns `return_code=3`:

1. Paykit writes `pending_refunds` row with state='processing'
2. Reconciler (default: every 5 min via consumer's cron) polls `adapter.refund` with same idempotencyKey
3. Provider returns final status → row transitions to `completed` or `failed`
4. Hard timeout: 24h. Row marked `timed_out`, admin gets surface in reconciliation summary

V1.5 admin UI for pending refunds is read-only (`GET /admin/billing/pending-refunds` — V1.6 candidate).

## Manual SePay reversal

SePay's bank transfer is one-way. To reverse:

1. Manually transfer money back to customer (out-of-band)
2. Record paykit ledger debit:
```bash
curl -X POST /admin/billing/ledger/adjust \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "<uuid>",
    "ownerId": "<uuid>",
    "amountMicros": "-1000000",
    "currencyCode": "VND",
    "entryType": "manual_adjustment",
    "reason": "Manual reversal of SePay tx <id>: customer dispute resolved"
  }'
```

The `entry_type='manual_adjustment'` distinguishes from automated `refund` entries.

## Coinbase Commerce — no refund API (operator runbook)

Coinbase Commerce exposes **create and read on charges and nothing else** — its
own SDKs declare exactly those two operations. The adapter therefore returns
`state: 'unsupported'` and `POST /admin/billing/refund` answers **501** for
`coinbase-commerce` transactions. This is a property of the provider, not a
paykit gap; there is no webhook to wait for.

To refund a Coinbase Commerce payment:

1. Send the crypto back to the customer **from your Coinbase account**
   (out-of-band — commerce.coinbase.com dashboard or a normal Coinbase send).
   Record the tx hash.
2. Record the paykit ledger debit so the balance matches reality:

```bash
curl -X POST /admin/billing/ledger/adjust \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid — one per adjustment>" \
  -d '{
    "tenantId": "<uuid>",
    "ownerId": "<uuid>",
    "amountMicros": "-5000000",
    "currencyCode": "USD",
    "entryType": "manual_adjustment",
    "reason": "Coinbase Commerce refund of tx <paykit transactionId>, sent <coin> <txhash>"
  }'
```

3. Reference the paykit `transactionId` and the on-chain tx hash in `reason` —
   reconciliation reads Coinbase's charge list, and an unexplained ledger delta
   on a refunded charge is exactly what it flags.

Do NOT mark the transaction `refunded` by hand-editing the row; the
`manual_adjustment` ledger entry is the audit trail.
