# ZaloPay Sandbox Setup

ZaloPay sandbox requires **merchant registration** (free for testing).

## Step 1 — Register ZaloPay Merchant

1. Visit https://merchant.zalopay.vn/dang-ky
2. Apply for sandbox account (provide email + company name; business KYC deferred to production)
3. Receive within 1-2 days:
   - `app_id` (numeric, e.g. `2553`)
   - `key1` — for signing create-order/refund requests
   - `key2` — for verifying callback signatures (DIFFERENT from key1)

**Two-key architecture is unique to ZaloPay** — paykit's adapter enforces separation.

## Step 2 — Configure env

```
ZALOPAY_APP_ID=2553
ZALOPAY_KEY1=<paste from dashboard>
ZALOPAY_KEY2=<paste from dashboard, different value>
ZALOPAY_RETURN_URL=https://your-app.com/billing/return/zalopay
ZALOPAY_CALLBACK_URL=https://your-app.com/webhooks/zalopay
```

## Step 3 — Wire adapter

```ts
import { createZaloPayAdapter } from "@vibecc/paykit-zalopay";

const zalopay = createZaloPayAdapter({
  appId: process.env.ZALOPAY_APP_ID!,
  key1: process.env.ZALOPAY_KEY1!,
  key2: process.env.ZALOPAY_KEY2!,
  returnUrl: process.env.ZALOPAY_RETURN_URL!,
  callbackUrl: process.env.ZALOPAY_CALLBACK_URL!,
  environment: "sandbox",
});
```

## Step 4 — Test top-up

```bash
curl -X POST https://your-app.com/billing/checkout/zalopay \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <user-token>" \
  -d '{ "amountVnd": 50000 }'
```

Response includes:
- `webUrl` — ZaloPay-hosted payment page
- `mobileDeeplink: zalopay://app/payment?token=<zp_trans_token>` — opens ZaloPay app
- `qrUrl` (if requested)

Test mobile deeplink on a device with ZaloPay Sandbox app (download from ZaloPay merchant portal).

## Step 5 — Production cutover

1. Submit business KYC via merchant.zalopay.vn (4-6 weeks)
2. After approval: production app_id/key1/key2 issued
3. Update env + set `environment: 'production'`

Production refund window: 90 days (shorter than other VN providers).

## ZaloPay's 2-step refund

Unlike VNPay/Momo (synchronous), ZaloPay refund returns `return_code=3` (PROCESSING) for some flows. Paykit handles this via `pending_refunds` table:

1. `POST /admin/billing/refund` → adapter returns `state='pending'`
2. Paykit writes `pending_refunds` row with provider='zalopay', state='processing'
3. Reconciler (every 5min by default) polls until `state` becomes `completed` or `failed`
4. Hard timeout: 24h. Row marked `timed_out` for admin attention.

Admin UI shows pending refunds via `GET /admin/billing/pending-refunds` (V1.6+).

## Common issues

- **Mixed key1/key2**: Paykit fails verification if you sign callback with key1 (must use key2). Adapter enforces separation.
- **`app_trans_id` format**: ZaloPay requires `YYMMDD_<id>` format. Paykit auto-generates from `transactionId` UUID; original UUID stored in `metadata.paykitTransactionId` (DB column `internal_id`).
- **Single-use `zp_trans_token`**: Don't cache the deeplink URL — token expires after first use.
- **Callback timezone**: ZaloPay uses UTC+7 (Vietnam) for `app_time` and `app_trans_id` date prefix. Adapter handles conversion.
