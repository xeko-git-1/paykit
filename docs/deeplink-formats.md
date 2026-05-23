# Per-Provider Deeplink + QR Format Reference

V1.5 surface contracts for `CheckoutResult.{webUrl, mobileDeeplink, qrUrl}`.

## Stripe
```
webUrl:         https://checkout.stripe.com/c/pay/cs_live_...
mobileDeeplink: undefined
qrUrl:          undefined
```

## SePay
```
webUrl:         https://img.vietqr.io/image/<bin>-<acc>-qr_only.png?amount=<vnd>&addInfo=<prefix>%20<orderId>
mobileDeeplink: undefined
qrUrl:          (same as webUrl — VietQR PNG)
```

## VNPay
```
webUrl:         https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_Amount=...&vnp_TmnCode=...&...&vnp_SecureHash=<hex>
mobileDeeplink: undefined
qrUrl:          undefined  (VNPay shows QR inside its hosted page)
```

## Momo
```
webUrl:         https://test-payment.momo.vn/pay/<sessionId>
mobileDeeplink: momo://app?action=payWithApp&...
qrUrl:          https://test-payment.momo.vn/qr/<sessionId>
```

## ZaloPay
```
webUrl:         https://sb-openapi.zalopay.vn/v2/pay/<orderId>
mobileDeeplink: zalopay://app/payment?token=<zp_trans_token>
qrUrl:          (returned only if create-order requested QR)
```

## Notes

- All `mobileDeeplink` URLs are single-use — don't cache
- Consumer's mobile app should always fall back to `webUrl` if deeplink fails to open
- See `docs/mobile-integration.md` for iOS Universal Links + Android App Links setup
