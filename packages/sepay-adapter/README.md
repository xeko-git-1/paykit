# @vibecc/paykit-sepay

Paykit V1.5 adapter for SePay (VietQR bank-transfer payments). Implements `PaymentProviderAdapter` from `@vibecc/paykit`.

**Note:** SePay refunds are NOT supported — bank transfers are one-way. Use `POST /admin/billing/ledger/adjust` for manual reversal.

## License

Proprietary.
