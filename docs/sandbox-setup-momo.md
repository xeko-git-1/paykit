# Momo Sandbox Setup

Momo sandbox requires MMOP (Momo Merchant Open Platform) registration. **Business account required**, but sandbox keys are free.

## Step 1 — Register MMOP partner

1. Visit https://business.momo.vn
2. Sign in with personal Momo (test account OK for sandbox)
3. Apply for "Test Sandbox" account
4. Receive within hours:
   - `partnerCode` (e.g. `MOMO`)
   - `accessKey` (e.g. `F8BBA842ECF85`)
   - `secretKey` (e.g. `K951B6PE1waDMi640xX08PD3vg6EkVlz`)

For production, full business KYC:
- Business license
- Tax registration
- Bank account in business name
- Signed merchant agreement (4-8 weeks)

## Step 2 — Configure URLs

Set in your app's env:

```
MOMO_PARTNER_CODE=MOMO
MOMO_ACCESS_KEY=F8BBA842ECF85
MOMO_SECRET_KEY=K951B6PE1waDMi640xX08PD3vg6EkVlz
MOMO_RETURN_URL=https://your-app.com/billing/return/momo
MOMO_IPN_URL=https://your-app.com/webhooks/momo
```

For local dev: Cloudflare Tunnel or ngrok (Momo's IPN must be public-reachable).

## Step 3 — Wire adapter

```ts
import { createMomoAdapter } from "@xeko-git-1/paykit-momo";

const momo = createMomoAdapter({
  partnerCode: process.env.MOMO_PARTNER_CODE!,
  accessKey: process.env.MOMO_ACCESS_KEY!,
  secretKey: process.env.MOMO_SECRET_KEY!,
  returnUrl: process.env.MOMO_RETURN_URL!,
  ipnUrl: process.env.MOMO_IPN_URL!,
  environment: "sandbox",
});
```

## Step 4 — Test top-up

```bash
curl -X POST https://your-app.com/billing/checkout/momo \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <user-token>" \
  -d '{ "amountVnd": 50000 }'
```

Response:
```json
{
  "data": {
    "transactionId": "uuid-...",
    "provider": "momo",
    "webUrl": "https://test-payment.momo.vn/...",
    "mobileDeeplink": "momo://app?action=...",
    "qrUrl": "https://test-payment.momo.vn/qr/...",
    "expiresAt": "..."
  }
}
```

Test mobile deeplink on a device with Momo Test app installed (download from MMOP portal).

## Step 5 — Production cutover

1. Submit production application via MMOP business dashboard
2. After approval: replace partnerCode/accessKey/secretKey with production values
3. Set `environment: 'production'`
4. Update webhook URL in Momo merchant dashboard

Production refund window: 180 days. Partial refunds supported.

## Common issues

- **Canonical string mismatch**: Momo signature is HMAC-SHA256 over alphabetically-sorted `key=value` pairs joined by `&`. Order matters. Paykit's `buildCreateOrderCanonical` enforces this.
- **Sandbox `payWithMethod` deprecation**: Momo plans v3 API. Paykit V1.5 locks to v2 stable. v3 migration in V2.0+.
- **MMOP register slow**: Production approval takes 4-8 weeks. Use sandbox until then.
