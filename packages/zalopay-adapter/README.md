# @xeko-git-1/paykit-zalopay

Paykit V1.5 adapter for ZaloPay (e-wallet popular with Vietnam Gen Z). Implements `PaymentProviderAdapter` from `@xeko-git-1/paykit`.

Supports server-to-server `create-order` → web `order_url` + mobile deeplink (`zalopay://`), HMAC-SHA256 callback verification with **2 keys** (key1 for sign, key2 for verify), and 2-step refund flow with `pending_refunds` table for PROCESSING state.

## License

Proprietary.
