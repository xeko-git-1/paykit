# Mobile Deeplink Integration

Paykit V1.5 supports mobile deeplink for providers whose user flow includes a native app handoff (Momo, ZaloPay). VNPay and Stripe are pure web redirect.

## CheckoutResult shape (per-provider)

| Provider | webUrl | mobileDeeplink | qrUrl |
|---|---|---|---|
| Stripe | ✅ | — | — |
| SePay | ✅ (= qrUrl) | — | ✅ |
| VNPay | ✅ | — | — |
| Momo | ✅ | ✅ `momo://app?action=...` | ✅ |
| ZaloPay | ✅ | ✅ `zalopay://app/payment?token=...` | ✅ |

## Recommended consumer mobile flow

1. Consumer's mobile app calls `POST /billing/checkout/{providerId}` → receives `{webUrl, mobileDeeplink, qrUrl}`
2. If `mobileDeeplink` present and on iOS/Android native:
   - Try `mobileDeeplink` (opens Momo/ZaloPay app if installed)
   - Fall back to `webUrl` if scheme not handled (no app, browser-only)
3. After user pays, provider redirects to consumer's universal-link URL (e.g. `https://yourapp.com/paykit-callback/<txId>`)
4. Consumer's mobile app catches universal-link, calls `paykit.verifyReturnUrl()` (read-only) for UX confirmation
5. Source of truth = IPN webhook (NOT return URL) — see `docs/webhooks.md`

## iOS Universal Links setup

`apple-app-site-association` (publish at `https://yourapp.com/.well-known/apple-app-site-association`):

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAMID.com.yourcompany.yourapp",
        "paths": ["/paykit-callback/*"]
      }
    ]
  }
}
```

## Android App Links setup

`AndroidManifest.xml`:

```xml
<activity android:name=".PaykitCallbackActivity" android:exported="true">
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="yourapp.com" android:pathPrefix="/paykit-callback/" />
  </intent-filter>
</activity>
```

Plus `https://yourapp.com/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.yourcompany.yourapp",
    "sha256_cert_fingerprints": ["AA:BB:CC:..."]
  }
}]
```

## Per-provider deeplink format

### Momo
- Scheme: `momo://app?action=payWithApp&...`
- Always returned in CheckoutResult.mobileDeeplink when create-order succeeds
- If user doesn't have Momo app, opening the deeplink falls through (consumer's mobile app should fall back to `webUrl`)

### ZaloPay
- Scheme: `zalopay://app/payment?token=<zp_trans_token>`
- The `zp_trans_token` is single-use; opening the same deeplink twice fails on the second attempt
- App-to-app handoff is preferred over webUrl when ZaloPay app installed

### VNPay
- No native app deeplink. Always uses `webUrl` redirect.
- VNPay shows its own QR/bank selection inside the redirected web page.

### Stripe
- No native app deeplink (Stripe Checkout is web-only by design).
- Use Stripe SDK (StripeKit on iOS, Stripe Android SDK) directly if you need native UI.

### SePay
- No deeplink — SePay is bank-transfer-by-QR. Consumer's mobile app shows the QR; user scans with their banking app.

## Testing

V1.5 sandbox creds for Momo and ZaloPay are required to test deeplinks against real apps. CI specs only test URL construction (string format); on-device verification is manual.

## Common pitfalls

1. **Universal link not registered**: iOS won't open your app on first install — open Settings > Universal Links > toggle for your app
2. **Custom scheme conflict**: `momo://` opens whichever app registered the scheme last. Universal Links (`https://...`) are more reliable
3. **Token reuse**: ZaloPay `zp_trans_token` is single-use. Don't cache.
4. **Race vs IPN**: User redirects to your callback URL BEFORE provider's IPN sometimes arrives. Always wait for IPN webhook to mark transaction complete; return URL is for UX only.
