# Phase 01 — Fix NowPayments async-refund resolution + regression test

## Context links
- Bug locus: `packages/server/src/routes/webhooks/webhook-router.ts:177-205`
- Root cause: `packages/nowpayments-adapter/src/webhook-events.ts:102-121`
- Contract: `packages/core/src/adapters/webhook-types.ts:34` (`refundAmountMicros?`)
- Reference impl (correct): `packages/stripe-adapter/src/adapter.ts:151-168`, `packages/stripe-subscription-adapter/src/webhook-events.ts:181`
- Admin write side: `packages/server/src/routes/admin/refund-route.ts:186-231`
- Docs flow: `docs/refund-flows.md:24-42`

## Overview
- **Priority:** P1 (financial-correctness regression in shipped code)
- **Status:** pending
- Repair the resolution half of the `refund_pending_webhook` flow so a NowPayments
  `payment.refunded` IPN actually writes the ledger refund + flips status
  `refund_pending_webhook → refunded`.

## Key insights (verified)
- `webhook-router.ts:178` guards the `payment.refunded` case:
  `if (evt.refundAmountMicros === undefined || evt.currencyCode === undefined) return;`
- `parseNpIpn` (`webhook-events.ts:102-121`) populates `amountMicros` and
  `expectedAmountMicros` but **never** `refundAmountMicros`.
- Therefore every NowPayments refund IPN hits the early `return` → no ledger entry,
  status stuck at `refund_pending_webhook`. Adapter unit test
  (`adapter.test.ts:206-231`) only asserts `evt.type === 'payment.refunded'`; it does
  NOT assert the amount field, so the bug passed CI.
- Stripe sets `refundAmountMicros` on its refund event — NowPayments diverged from the
  established adapter convention.
- The router refund case does NOT gate on `row.status` (unlike completed/expired/failed),
  so the only blocker is the missing amount field — the fix is sufficient to unstick.

## Requirements
**Functional**
- A signed NowPayments `refunded` IPN MUST yield a `NormalizedWebhookEvent` with
  `refundAmountMicros` set and `currencyCode` set.
- After the IPN, exactly one `refund` ledger entry exists and tx status is `refunded`.
- RT F10 race protection preserved: admin sync-success path + webhook path collapse to
  one entry via `appendLedgerEntryIdempotent` UNIQUE(provider, source_id, entry_type).

**Non-functional**
- No new migration (011 already ships the enum value).
- Keep `nowpayments-adapter/src` under the 30KB bundle budget (`adapter.test.ts:318-329`).

## Architecture / data flow
```
NP refunded IPN ─► verifyNpSignature ─► parseNpIpn
   (now sets refundAmountMicros + currencyCode on type=payment.refunded)
        │
        ▼
webhook-router payment.refunded case (line 177)
   guard passes ─► appendLedgerEntryIdempotent(entry_type='refund', sourceId=order_id)
   inserted ─► applyDelta(-refundMicros) ─► updateTransactionStatus('refunded')
   second-writer (admin already wrote) ─► inserted=false ─► no double debit
```

## Decision: fix in the adapter, not the router
Populate `refundAmountMicros` in `parseNpIpn` for `payment.refunded` (KISS + matches
Stripe convention; keeps router generic). Source value: `actually_paid ?? price_amount`
(same micros conversion already used at `webhook-events.ts:66-71`). Do NOT loosen the
router guard to fall back to `amountMicros` — that would mask future adapter omissions.

## Related code files
- **Modify:** `packages/nowpayments-adapter/src/webhook-events.ts` — in `parseNpIpn`, when
  `baseType === 'payment.refunded'`, set `refundAmountMicros` (from `actually_paid ??
  price_amount`) on the returned event. Leave `currencyCode` as-is (already set).
- **Modify:** `packages/nowpayments-adapter/__tests__/webhook-events.test.ts` — assert
  `refundAmountMicros` present + correct on a `refunded` payload.
- **Modify:** `packages/nowpayments-adapter/__tests__/adapter.test.ts:206-231` — extend the
  round-trip test to assert `evt.refundAmountMicros`.
- **Create:** server-integration regression test (location: `packages/server/__tests__/` if
  a DB-backed harness exists there, else extend `e2e/consumer-app/tests/`) — drive a NP
  `refunded` IPN through `buildWebhookRouter` against a row in `refund_pending_webhook` and
  assert: one `refund` ledger entry + status `refunded`. **Scout the existing server test
  setup before writing — do not invent a DB harness.**

## Implementation steps
1. Re-grep `refundAmountMicros` producers to confirm Stripe pattern, then mirror it in
   `parseNpIpn`. Spread conditionally: `...(refundMicros !== undefined ? { refundAmountMicros: refundMicros } : {})`.
2. Update the two adapter unit tests to lock the amount field.
3. Scout `packages/server/__tests__/` for an existing webhook-router integration harness
   (the router already has completed/refunded coverage somewhere — find it). Add the
   stuck-row → refunded regression there using the SAME harness.
4. `pnpm --filter @vibecc/paykit-nowpayments build` + run nowpayments + server test files.

## Todo
- [x] `parseNpIpn` sets `refundAmountMicros` on `payment.refunded`
- [x] Adapter unit tests assert amount field
- [x] Server integration regression test: stuck row → `refunded` + 1 ledger entry
- [x] Adapter builds; targeted tests green; bundle budget still passes

## Success criteria
- New regression test fails on current `main` (proves the bug) and passes after fix.
- NP refund IPN writes exactly one `refund` ledger entry; status `refund_pending_webhook → refunded`.
- No change to migrations; bundle-size test still green.

## Risk assessment
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Partial-refund amount wrong (IPN reports total, not delta) | Med | High | Full-refund only for V3 GA; flag partial as open question; cap at remaining via existing admin math on the sync path |
| No server-side webhook integration harness exists | Med | Med | Scout first; fall back to e2e consumer-app harness; do not fabricate DB mocks |
| Loosening router guard instead of adapter fix | Low | Med | Decision locks fix in adapter to keep router strict |

## Rollback
Single-file adapter change + tests. Revert `webhook-events.ts` hunk; no schema/data
migration involved, so rollback is clean.

## Security considerations
No auth surface change. Signature verify (`verifyNpSignature`) path untouched. Idempotency
UNIQUE constraint continues to prevent double-credit on provider IPN replay.

## Open questions
1. **[BLOCKING for partial refunds]** Does the NowPayments `refunded` IPN carry the
   refunded amount as a delta or echo the original `price_amount`/`actually_paid`? If it
   echoes the original, partial refunds would over-debit. Confirm against NP IPN docs before
   claiming partial-refund support; V3 GA can ship full-refund-only and defer partial.
2. Is there an existing server-level webhook-router integration test dir, or is router
   coverage only in adapter unit tests + e2e? Determines where the regression test lands.
