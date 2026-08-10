# @xeko-git-1/paykit-sepay

Paykit V1.5 adapter for SePay (VietQR bank-transfer payments). Implements `PaymentProviderAdapter` from `@xeko-git-1/paykit`.

**Note:** SePay refunds are NOT supported — bank transfers are one-way. Use `POST /admin/billing/ledger/adjust` for manual reversal.

## License

Proprietary.
