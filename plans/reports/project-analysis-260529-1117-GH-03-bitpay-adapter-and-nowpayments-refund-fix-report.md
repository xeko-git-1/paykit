# Paykit — Current-State Analysis + Next-Phase Plan (GH-03)

Date: 2026-05-29 | Branch: `feat/v3-phase-03-nowpayments-adapter` | Read-only investigation.

## 1. Architecture reality vs docs
- 12 pnpm packages: `core` (contracts/types/registry/money/errors/secrets/subscriptions),
  `server` (Hono+Drizzle, create-paykit + routes), `workers` (reconcile), `react` (admin UI),
  `cli`, + 7 provider adapters: stripe, stripe-subscription, sepay, vnpay, momo, zalopay,
  nowpayments.
- Plug-in model: adapters implement `PaymentProviderAdapter` (`packages/core/src/adapters/adapter.ts:20`),
  registered into per-instance `ProviderRegistry` (`registry.ts:14`, NOT a singleton). Generic
  `buildWebhookRouter` mounts `/webhooks/{id}` per adapter (`webhook-router.ts:63`); admin refund
  is fully generic (`refund-route.ts`). Adding an adapter needs **no** server/core edits.
- **README is STALE:** `README.md:5` "Status: V1 development"; `:25` lists only 5 packages; `:58`
  says docs come in "Phase 11" — but `docs/` is already populated and repo is at V3. Reality:
  V1 → V1.5 (VN providers + cross-provider refund) → V2 (stripe-subscription) → V3 (crypto).

## 2. V3 Phase 03 (NowPayments) — what shipped
- `@vibecc/paykit-nowpayments` v0.3.0-rc.0: `adapter.ts` (checkout/refund/fetchTransactions),
  `webhook-verifier.ts` (HMAC-SHA512 over canonical sorted-JSON, header `x-nowpayments-sig`,
  rotation-array secrets, constant-time compare), `webhook-events.ts` (NP status → event map).
- New payment state `refund_pending_webhook` via **migration 011** (`011_*.up.sql:18-28`); 010
  added `quarantine`. Both are additive CHECK-constraint extensions.
- Refund async semantics: NP 4xx/5xx OR 2xx-without-`refund_id` OR network error → adapter
  returns `state:'pending_webhook'` (`adapter.ts:176-255`); server writes
  `status='refund_pending_webhook'` + 202, defers ledger to webhook (`refund-route.ts:186-231`).

## 3. **P0 bug found in shipped Phase 03** (financial correctness)
- The **resolution half is broken.** `webhook-router.ts:178` guards `payment.refunded` with
  `if (evt.refundAmountMicros === undefined || evt.currencyCode === undefined) return;` —
  but NowPayments' `parseNpIpn` (`webhook-events.ts:102-121`) sets `amountMicros` /
  `expectedAmountMicros`, **never `refundAmountMicros`**.
- Net: a signed NP `refunded` IPN is silently skipped → no `refund` ledger entry, status stuck
  forever at `refund_pending_webhook`. Stripe correctly sets `refundAmountMicros`
  (`stripe-adapter/src/adapter.ts:168`) — NowPayments diverged from the convention.
- Why CI missed it: adapter test `adapter.test.ts:206-231` asserts only `evt.type ===
  'payment.refunded'`, not the amount field; no server-integration test drives a stuck row to
  resolution. **This is the keystone of the plan — fix before BitPay reuses the same path.**

## 4. What's pending / in-flight
- **BitPay (V3 Phase 02): NOT started.** No `packages/bitpay-adapter`. Only doc/comment refs:
  `docs/refund-flows.md:41`, `migrations/011_*.up.sql:3`, `refund-types.ts:10`, refund-route
  comments, and a reconciler test stub `reconciler-string-provider-typing.test.ts:42`. It would
  reuse the exact `pending_webhook` infra NowPayments just built (and the bug).
- **V3.1 auto-timeout** for stuck `refund_pending_webhook` explicitly deferred
  (`011_*.up.sql:12-13`, `refund-flows.md:37`). NowPayments has NO reconciler/timeout — manual
  via `/admin/billing/ledger/adjust` only.
- **Boundary-guard gap:** only `v1-boundary-guards.test.ts` exists; no V2/V3 equivalent. Note: V2
  subscription code lives in a separate package NOT in the test's `SRC_DIRS`, so the V1 guard may
  still legitimately pass — verify, don't assume.

## 5. Adapter consistency
- All 7 adapters share the `PaymentProviderAdapter` contract from core; zero-runtime-dep ESM
  packages with `peerDependencies: @vibecc/paykit`. Webhook normalization to
  `NormalizedWebhookEvent` is uniform.
- **Divergence:** NowPayments introduced `pending_webhook` refund state (correct, server
  supports it) BUT failed to emit `refundAmountMicros` on refund events (the bug above). VN
  providers (sepay/vnpay/momo/zalopay) + Stripe do not use `pending_webhook` and don't need to —
  it's crypto-async-specific. No forced migration onto other adapters.

## Test/build health (mapped, not run)
- Vitest root config (`vitest.config.ts`): includes `packages/**/__tests__/**`, `packages/**/*.test.ts`,
  `e2e/**/tests/**`. v8 coverage.
- Core has 24 contract/boundary tests incl. `adapter-interface`, `provider-registry`,
  `v3-webhook-types-extended`, `v1-boundary-guards`. NowPayments has 4 test files. e2e has
  `consumer-app/tests/harness-smoke.test.ts`. No server-side webhook-router integration test was
  located for the refund-resolution path (gap that hid the P0).

## Recommended next phase
**Phase 01 — fix the NowPayments async-refund resolution bug FIRST** (P1, financial
correctness), then **Phase 02 — BitPay adapter** on the now-correct infra, then **Phase 03 —
README/docs sync** (independent). Sequencing: BitPay must not inherit the broken path.

Plan files written under
`plans/260529-1117-GH-03-bitpay-adapter-and-nowpayments-refund-fix/`.

## Open questions
1. NP `refunded` IPN: does it carry refund *delta* or echo original amount? Blocks partial-refund
   correctness (full-refund-only is a safe V3 GA fallback).
2. Is there any server-level webhook-router integration harness, or only adapter unit + e2e?
   Determines where the Phase-01 regression test lands.
3. BitPay current API surface + IPN auth scheme (NOT HMAC like NP) — must be scouted, not assumed.
4. Is the V1 boundary guard meant to gain a V2/V3 variant, or stay V1-scoped?
