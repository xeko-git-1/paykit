# Phase 02 — BitPay adapter (V3 Phase 02)

## Context links
- Adapter contract: `packages/core/src/adapters/adapter.ts:20-44`
- Refund contract: `packages/core/src/adapters/refund-types.ts:17-36`
- Webhook event shape: `packages/core/src/adapters/webhook-types.ts:19-38`
- Reference package (mirror this shape): `packages/nowpayments-adapter/{src,__tests__,package.json,tsconfig.json}`
- Server pending_webhook branch (reused unchanged): `packages/server/src/routes/admin/refund-route.ts:186-231`
- Generic router (reused unchanged): `packages/server/src/routes/webhooks/webhook-router.ts`
- Doc promising BitPay: `docs/refund-flows.md:41`, `migrations/011_*.up.sql:3`
- Reconciler stub already referencing bitpay: `packages/workers/__tests__/reconciler-string-provider-typing.test.ts:42`

## Overview
- **Priority:** P2
- **Status:** pending
- **Depends on:** Phase 01 (resolution path must work before BitPay reuses it)
- Build `@vibecc/paykit-bitpay` implementing `PaymentProviderAdapter`, mirroring the
  NowPayments package, with BitPay's own IPN signature scheme + async (`pending_webhook`)
  refund semantics. No server/core code changes (adapter plugs into the generic router).

## Key insights (verified)
- Adapters are self-contained packages with `peerDependencies: { "@vibecc/paykit": ">=0.3.0-rc.0 <0.4.0" }`
  and zero runtime deps (`nowpayments-adapter/package.json`). BitPay should match.
- The server already routes `pending_webhook` (refund-route.ts:186) and `payment.refunded`
  (webhook-router.ts:177) generically — **no server edits** needed once the adapter returns
  the right `RefundResult.state` and emits a proper `NormalizedWebhookEvent`.
- `ProviderRegistry` (registry.ts) keys adapters by `id`; `id` becomes the webhook path
  `/{id}`. Use `id = "bitpay"`. Forbidden id chars: `/ ? # whitespace`.
- BitPay reuses migrations 010 (`quarantine`) + 011 (`refund_pending_webhook`) — **no new
  migration** unless BitPay needs a status the enum lacks (it shouldn't).
- A reconciler test already expects a `bitpay` key in stats — confirm whether BitPay needs
  to appear in the workers reconcile registry (likely yes, for `fetchTransactions`).

## Requirements
**Functional**
- `createCheckout` → BitPay invoice create; return `webUrl`/`qrUrl`/`expiresAt`/`providerSessionId`.
- `verifyWebhookSignature` → BitPay's scheme (BitPay uses an `x-signature` ECDSA/SIN or
  token-based IPN — **confirm current BitPay IPN auth before coding**; do NOT assume HMAC).
- `parseWebhookPayload` → map BitPay invoice status → `WebhookEventType`; on refund event,
  set BOTH `currencyCode` and `refundAmountMicros` (Phase 01 lesson — the router needs it).
- `refund` → POST refund; async confirmation → return `state: 'pending_webhook'` on
  accepted-but-unconfirmed / transient errors, mirroring NowPayments semantics.
- `fetchTransactions` → paginated settled-invoice list → `ProviderTxnRecord[]`.

**Non-functional**
- src/ under a small bundle budget (mirror NP's 30KB test).
- Zero runtime deps; ESM; Node ≥ 20.

## Architecture / data flow
```
consumer createPaykit({ providers: { bitpay: {...} } })
  └─ registry.register(createBitpayAdapter(cfg))   id='bitpay'
       ├─ /webhooks/bitpay  → generic webhook-router (unchanged)
       └─ /admin/billing/refund → refund-route pending_webhook branch (unchanged)
```
Status mapping (confirm exact BitPay statuses):
`confirmed/complete → payment.completed`, `expired → payment.expired`,
`invalid/declined → payment.failed`, `refunded → payment.refunded`,
underpaid/overpaid → `payment.underpaid` / amount-drift → `payment.amount_mismatch`
(reuse NowPayments' >5bps quarantine logic for parity).

## Related code files
- **Create:** `packages/bitpay-adapter/package.json` (copy NP, rename to `@vibecc/paykit-bitpay`)
- **Create:** `packages/bitpay-adapter/tsconfig.json`
- **Create:** `packages/bitpay-adapter/src/index.ts`
- **Create:** `packages/bitpay-adapter/src/adapter.ts`
- **Create:** `packages/bitpay-adapter/src/webhook-events.ts`
- **Create:** `packages/bitpay-adapter/src/webhook-verifier.ts`
- **Create:** `packages/bitpay-adapter/__tests__/{adapter,webhook-events,webhook-verifier}.test.ts`
- **Maybe modify:** workers reconcile registry if BitPay must be polled (check
  `packages/workers/src/reconcile/*` + the existing bitpay reconciler test stub).
- **No migration. No core change. No server change.**

## Implementation steps
1. Scout BitPay's CURRENT API: invoice-create endpoint, invoice status enum, IPN signature
   scheme, refund endpoint + async semantics. Use docs-seeker/context7. Do NOT guess auth.
2. Scaffold the package from the NowPayments shape (package.json, tsconfig, index barrel).
3. Implement `webhook-verifier.ts` for BitPay's real IPN auth (constant-time compare,
   secret-rotation array like NP `webhook-verifier.ts:40-64`).
4. Implement `webhook-events.ts` status map; ensure refund event sets `refundAmountMicros`.
5. Implement `adapter.ts` (`createCheckout`/`refund`/`fetchTransactions`), refund returns
   `pending_webhook` on transient/accepted-unconfirmed.
6. Mirror NP's test suite; add a refund→webhook resolution test (the Phase-01 lesson).
7. `pnpm --filter @vibecc/paykit-bitpay build` + run its tests.
8. Update `docs/refund-flows.md:41` BitPay row from "pending" to shipped; bump release-manifest.

## Todo
- [ ] Confirm BitPay invoice/status/IPN-auth/refund API (no assumptions)
- [ ] Scaffold `@vibecc/paykit-bitpay` from NP shape
- [ ] Signature verifier (real BitPay scheme)
- [ ] Status map + refund event sets `refundAmountMicros`
- [ ] adapter.ts checkout/refund(pending_webhook)/fetchTransactions
- [ ] Test suite incl. refund→webhook resolution
- [ ] Build + tests green; docs row flipped to shipped

## Success criteria
- `@vibecc/paykit-bitpay` builds, exports `createBitpayAdapter`.
- Registering it adds `/webhooks/bitpay`; a refund returns `pending_webhook`; a subsequent
  signed refund IPN writes one ledger entry + flips status to `refunded` (end-to-end via the
  generic router — proves it inherited the Phase-01 fix, not the bug).
- Adapter contract test in core passes for the new adapter shape.

## Risk assessment
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wrong assumption about BitPay IPN auth (it is NOT HMAC like NP) | High | High | Step 1 mandatory API scout; cite BitPay docs; no copy-paste of NP HMAC |
| Refund event omits `refundAmountMicros` (repeats Phase-01 bug) | Med | High | Resolution test is a required todo; lesson encoded in step 4 |
| BitPay needs a status the enum lacks | Low | Med | Confirm status set in step 1; only add migration if truly required |

## Rollback
New package, additive only. Remove `packages/bitpay-adapter/` + revert the doc row + manifest
bump. No data or schema impact.

## Security considerations
- IPN signature verify MUST be implemented correctly for BitPay's scheme — a wrong scheme
  that always returns true is a forged-webhook → free-credit vector. Constant-time compare.
- Network-exposed `/webhooks/bitpay` is unauthenticated by design (provider-signed);
  signature verify IS the auth. Reject on missing/invalid signature (mirror NP 401 path).
- USD-only `supportedCurrencies` unless BitPay settlement says otherwise.

## Open questions
1. Current BitPay product line — classic Invoices API vs newer flows? Endpoint + status enum
   must be confirmed (BitPay has changed APIs historically).
2. Exact IPN signature mechanism (token-based vs `x-signature`)? Drives webhook-verifier.
3. Does BitPay confirm refunds synchronously sometimes? If so, support `state:'completed'`
   like NowPayments' `refund_id` branch.
4. Must BitPay join the workers reconcile registry now, or defer (the test stub suggests
   it's expected)? Confirm against `packages/workers/src/reconcile/*`.
