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
4. If webhook never arrives within 24h → manual reconcile via `/admin/billing/ledger/adjust` (auto-timeout deferred to V3.1)

**Race protection (RT F10):** Both the admin sync-success path and the webhook `refunded` path use `appendLedgerEntryIdempotent`. Whichever fires second gets `{inserted: false}` and skips `applyDelta` — exactly one ledger entry regardless of timing.

**Providers using this state:**

- **NowPayments** (`@vibecc/paykit-nowpayments`) — signed IPN (HMAC-SHA512); refund IPN resolves the ledger debit + flips status to `refunded`.
- **BitPay** (`@vibecc/paykit-bitpay`) — adapter shipped. BitPay does NOT sign webhooks, so authentication is **fetch-back** (`GET /invoices/:id`) via the adapter's async `resolveWebhook` hook rather than a signature check. Refund requires an injected merchant ECDSA signer (`BitpayMerchantSigner`); the refund returns `pending_webhook`, but the refund-confirmation webhook shape is not yet sandbox-verified, so refunds resolve via **manual reconcile** until that wiring lands.

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
