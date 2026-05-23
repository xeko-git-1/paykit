# VNPay Sandbox Setup

VNPay's sandbox is **public + free** — no business KYC required for testing.

## Step 1 — Register sandbox merchant

1. Visit https://sandbox.vnpayment.vn/devreg
2. Fill in:
   - Company name (test value OK)
   - Email
   - Phone
3. Submit → receive credentials by email within minutes:
   - `vnp_TmnCode` — your terminal code (e.g. `EOJSFJDC`)
   - `vnp_HashSecret` — HMAC-SHA512 secret

## Step 2 — Configure webhook IPN URL

In VNPay sandbox dashboard:

- IPN URL: `https://your-app.com/webhooks/vnpay`
- Return URL: `https://your-app.com/billing/return/vnpay`

For local dev, use Cloudflare Tunnel or ngrok to expose `localhost:3000` publicly:

```bash
cloudflared tunnel --url http://localhost:3000
```

## Step 3 — Wire paykit adapter

```ts
import { createVnpayAdapter } from "@vibecc/paykit-vnpay";

const vnpay = createVnpayAdapter({
  tmnCode: process.env.VNPAY_TMN_CODE!,
  hashSecret: process.env.VNPAY_HASH_SECRET!,
  returnUrl: "https://your-app.com/billing/return/vnpay",
  ipnUrl: "https://your-app.com/webhooks/vnpay",
  environment: "sandbox",
});
```

## Step 4 — Test top-up

```bash
curl -X POST https://your-app.com/billing/checkout/vnpay \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <user-token>" \
  -d '{ "amountVnd": 50000 }'
```

Response includes `webUrl` → redirect user. Use VNPay's sandbox card numbers:
- NCB: `9704198526191432198` / OTP `123456`
- Other test cards in VNPay docs

## Step 5 — Production cutover

VNPay production requires **business merchant registration** (KYC):

1. Visit https://vnpay.vn/dang-ky
2. Submit company documents (business license, tax code)
3. Sign merchant agreement (2-4 weeks)
4. Receive production `vnp_TmnCode` + `vnp_HashSecret`
5. Update env vars + set `environment: 'production'`
6. Update webhook URL in production VNPay dashboard

Production refund window: 365 days from original transaction.

## Common issues

- **Signature mismatch**: VNPay requires strict RFC 3986 URL encoding (`%20` not `+`). Paykit's adapter handles this automatically.
- **IPN delays**: VNPay sandbox sometimes delivers IPN 30-60s late. Paykit's webhook_events PK handles dedup if Stripe retries.
- **`vnp_ResponseCode='99'`**: Generic error code from VNPay. Check `vnp_Message` field in IPN payload metadata.
