# Phase 03 — README + docs reality sync (V1.5 / V2 / V3)

## Context links
- Stale root: `README.md:5` ("Status: V1 development"), `README.md:58` ("docs authored in Phase 11")
- Reality of shipped work: git log (V1 → V1.5 → V2 stripe-subscription → V3 crypto adapters)
- Actual package set: 12 packages incl. `stripe-subscription`, `nowpayments` (and BitPay after Phase 02)
- Docs already authored: `docs/` (installation, refund-flows, v2-acceptance-tests, upgrading-*, etc.)
- Boundary-guard gap: `packages/core/__tests__/v1-boundary-guards.test.ts` (V1-only; no V2/V3 equivalent)

## Overview
- **Priority:** P3
- **Status:** pending
- **Depends on:** none (independent doc hygiene). Do the BitPay doc-row flip in Phase 02; this
  phase covers README + cross-doc reality, not the per-adapter rows.
- Bring root README + version-narrative docs in line with the actual V1.5/V2/V3 state.

## Key insights (verified)
- `README.md:5` still says "V1 development"; `README.md:25` lists only 5 packages; repo has 12
  packages including subscription + crypto adapters. `README.md:58` points docs to a future
  "Phase 11" that already shipped (`docs/` is populated).
- `README.md:9-21` "What it does / doesn't do (V1)" contradicts shipped V2 subscriptions +
  V1.5 VN providers (vnpay/momo/zalopay) + V3 crypto.
- The V1 boundary-guard test still enforces V1-only `FORBIDDEN_PATTERNS`. Per `V2-PREVIEW.md:54`,
  V2 code should have removed the relevant patterns. **Verify the guard didn't silently start
  failing or get neutered** — this is a correctness check, not just docs.

## Requirements
**Functional**
- README reflects: published version line (from package versions, e.g. `0.3.0-rc.0`), the full
  adapter list, links to existing `docs/`, and a short V1→V1.5→V2→V3 capability summary.
- A short "supported providers" matrix (Stripe, Stripe Subscription, SePay, VNPay, Momo,
  ZaloPay, NowPayments, +BitPay if Phase 02 merged) with currency + refund mode.
- Document/triage the boundary-guard state (V1 guard scope vs V2/V3 reality).

**Non-functional**
- Docs-only; no code/behavior change (except possibly adjusting the boundary-guard test scope,
  which is test-correctness, flag separately if touched).

## Decision: scope of the boundary-guard check
Do NOT silently delete or rewrite `v1-boundary-guards.test.ts`. First determine empirically
whether it currently passes (V2 subscription code lives in a SEPARATE package
`stripe-subscription-adapter`, which is NOT in the test's `SRC_DIRS` list — so it may still
pass legitimately). Report findings; only adjust if it is actually wrong. This honors the
"verified decisions are sticky / don't auto-reverse" rule.

## Related code files
- **Modify:** `README.md` (status line, package list, provider matrix, docs links, V-narrative)
- **Maybe modify:** `docs/installation.md` — confirm it lists all current adapters (it already
  shows NowPayments at line ~30; add BitPay if Phase 02 merged).
- **Investigate (maybe modify):** `packages/core/__tests__/v1-boundary-guards.test.ts` — verify
  scope correctness; document rather than blindly edit.
- **No new files** unless a `docs/providers.md` matrix is warranted (prefer extending README).

## Implementation steps
1. Read package versions to state the real version line in README.
2. Rewrite README status + package list + add provider/currency/refund matrix; replace the
   "Phase 11" docs note with real `docs/` links.
3. Reconcile "What it does/doesn't do" with shipped V1.5/V2/V3 scope.
4. Empirically run the V1 boundary-guard test; report pass/fail + whether its `SRC_DIRS` scope
   is still correct given V2 lives in a separate package. Adjust ONLY if demonstrably wrong.
5. If Phase 02 merged, add BitPay to README matrix + installation.md.

## Todo
- [x] README status/version/package-list updated to V3 reality
- [x] Provider × currency × refund-mode matrix added
- [x] "Phase 11" docs placeholder replaced with real `docs/` links
- [x] Boundary-guard state verified + documented (edited only if proven wrong)
- [x] Cross-check installation.md adapter list

## Success criteria
- README no longer claims "V1 development"; lists all shipped packages + providers.
- A reader can find the right doc for each provider from README.
- Boundary-guard status explicitly reported (pass + correct scope, or fix justified).

## Risk assessment
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Over-editing the boundary-guard test reverses a deliberate V1 guard | Med | Med | Verify-first; document; edit only if proven wrong (sticky-decision rule) |
| README drifts again next version | Low | Low | Add a 1-line "update on each version bump" note near the status line |

## Rollback
Docs-only; `git checkout` the markdown files. If boundary-guard test touched, revert that hunk
independently.

## Security considerations
None (documentation). Ensure no secrets/tokens pasted into README examples (use placeholders,
matching existing `${GITHUB_TOKEN}` style in installation.md).

## Open questions
1. Is the published version line `0.3.0-rc.0` the intended public number, or is there a separate
   release tag to cite?
2. Should the provider matrix live in README or a dedicated `docs/providers.md`? (Prefer README
   for discoverability unless it bloats.)
