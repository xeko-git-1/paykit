# Fix Report — NowPayments async-refund resolution (P1)

**Date:** 2026-05-29 | **Branch:** feat/v3-phase-03-nowpayments-adapter | **Scope:** Phase 01

## Root cause (verified)
`parseNpIpn` (`packages/nowpayments-adapter/src/webhook-events.ts`) never set `refundAmountMicros`. Router `payment.refunded` case (`packages/server/src/routes/webhooks/webhook-router.ts:178`) early-returns when `refundAmountMicros === undefined` → no ledger debit, status stuck at `refund_pending_webhook`. Stripe sets the field (`stripe-adapter/src/adapter.ts:168`); NowPayments diverged. CI missed it — adapter test only asserted `evt.type`.

Blast radius: any NowPayments refund (the whole `refund_pending_webhook` → `refunded` resolution path). Server credit/expire/failed paths unaffected (they use `amountMicros`).

## Fix
`webhook-events.ts`: when `type === 'payment.refunded'`, set `refundAmountMicros = actually ?? expected` (reverses exactly the credited `actually_paid`, fallback `price_amount`). Full-refund only; partial deferred. Router left strict (no guard loosening) to keep future adapter omissions visible.

## Verification
- Regression proven: 3 refund tests RED pre-fix (`expected undefined to be '50000000'`), GREEN post-fix.
- nowpayments suite 45/45; full workspace 598/598; `pnpm -r build` exit 0, 0 TS errors; bundle-budget test green.

## Decisions taken (autonomous)
- **Q1 partial vs full refund:** full-refund-only for V3 GA (matches `docs/refund-flows.md` matrix — NP not listed for partial). Source `actually ?? expected`. Partial flagged below.
- **Q2 server integration harness:** none exists (no `globalSetup`/Postgres in `vitest.config.ts`; server tests are `vi.fn()` + `expectTypeOf` only). Regression locked at adapter-unit level. Did NOT fabricate DB mock (development-rules).

## Out-of-scope findings (flagged, NOT fixed)
1. **CLI migration copy drift:** committed `packages/cli/migrations/` has `010_*.sql` but is missing `011_*.sql` + its manifest entry. Build (`copy:migrations`) regenerates from `/migrations` (source-of-truth, correct), so published package is fine — only the committed artifact is stale from the V3 Phase 03 commit. Reverted my regenerated copy to keep this fix scoped.

## Open questions
1. Partial-refund support for NowPayments — does NP `refunded` IPN ever carry a partial delta? If product wants partial, needs NP IPN-doc confirmation + cumulative-cap logic before claiming support.
2. Commit the regenerated CLI migration copy (011) as a separate `fix(cli):` commit?
