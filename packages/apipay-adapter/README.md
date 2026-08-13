# @xeko-git-1/paykit-apipay

Paykit adapter for ApiPay ([apipay.vn](https://apipay.vn) — Open Banking VND bank-transfer payment links). Implements `PaymentProviderAdapter` from `@xeko-git-1/paykit`.

- `createCheckout` calls `POST /v1/client/payment-requests` and returns the hosted `payUrl` (plus `qrUrl`); the transfer content embeds `brandPrefix + transactionId` so the webhook can be matched back.
- Webhooks are verified against the `ApiPay-Signature` header (HMAC-SHA256 of the raw body with the webhook secret — issued per webhook, separate from the API `secretKey`).
- Only `transaction.in` events credit; everything else is skipped.
- Reconciliation lists `COMPLETED` payment requests by date window, paged to the end.
- `verifyReturnUrl` is not implemented: ApiPay signs its redirect with a per-payment-request `redirectSecret`, which a stateless adapter cannot look up. Rely on the webhook for settlement truth.

**Note:** ApiPay refunds are NOT supported — bank transfers are one-way. Use `POST /admin/billing/ledger/adjust` for manual reversal.

## License

Proprietary.
