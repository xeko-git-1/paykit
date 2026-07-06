# Review Findings Landed Before the Reviewer Could Act

**Date**: 2026-05-31 22:15
**Severity**: High
**Component**: server (idempotency, webhooks, money-math, refunds)
**Status**: Resolved

## What Happened

Full security review of paykit (3 parallel subagents: tenant-isolation, webhook-signature, money-math). Found a critical cross-tenant IDOR, an HMAC bypass, a discount rounding bug, and several minors. Built a 4-phase fix plan. Then discovered a parallel V4 workstream was fixing the same findings in real-time — by the time I reached implementation, most of my plan targeted already-patched code.

## The Brutal Truth

Spending hours producing a meticulous plan only to find the codebase moved under you three separate times is demoralizing. The refund-core got refactored (`f400f8c`) while I was still writing up I3. The IDOR fix (`c676315`) and HMAC hardening (`c54e584`) landed while I was red-teaming. The I2 idempotency redesign (`c106ac7`, `a091314`) shipped while I was debating state-column semantics. My direct code contribution shrank to a slice folded into `0741f76`. The review and plan were valuable — the implementation credit went elsewhere.

## Technical Details

Key findings and their resolution commits (all verified in git):

| Finding | Severity | Fix Commit |
|---------|----------|------------|
| C1: cross-tenant IDOR via global `idempotency_key` UNIQUE | Critical | `c676315` |
| I1: HMAC adapters accept empty secret (forgeable) | Important | `c54e584`, `ff82c5c` |
| I3: partial refund #2 swallowed (shared sourceId) | Important | `f400f8c` (already fixed pre-plan) |
| I4: `Math.round(pct)` mangles fractional discounts | Important | `f9ec636` |
| I2: idempotency race + poison-record on crash | Important | `c106ac7`, `a091314` |
| M1: toBase62 non-injective | Minor | `f69c052` |
| M2/M5/M3: dead handlers, no 2-decimal guard, sub routes | Minor | `0741f76` |

Red-team caught that I3 was stale (already fixed) and that the original I2 plan would violate `responseStatus NOT NULL` + create a 24h poison lock. Both legitimate catches that prevented shipping broken migrations.

## Root Cause Analysis

No coordination protocol between the review/plan workstream and the V4 service-operability workstream. Both read the same findings doc; one planned, the other just fixed. The planner assumed HEAD was stable for the duration of analysis — it was not.

## Lessons Learned

1. **"Verified" has a short shelf life under concurrent work.** Re-read the target file immediately before implementing, not an hour before. A finding confirmed at 22:00 may be resolved by 23:00.
2. **Red-teaming your own plan catches real bugs.** The I2 poison-record and the stale-I3 catch both came from adversarial review of the plan itself, not from re-reading code.
3. **Review value != implementation credit.** The review surfaced the IDOR that got fixed in `c676315`. That fix exists because the review existed. The work mattered even though someone else typed the patch.

## Residual Risk

After C1, tenant isolation depends entirely on `tenant_id` JWT claim integrity. `jwt-middleware.ts:155-161` resolves `tenant_id ?? sub` with no cross-check against merchant record. If the JWT mint path ever lets a client set arbitrary `tenant_id`, C1's fix is defeated (confused-deputy). Flagged for dashboard-auth wiring — not yet addressed.

## Next Steps

- [ ] Add Postgres integration test harness (all migration tests are currently string-match only)
- [ ] Wire tenant_id cross-check in JWT mint path to close confused-deputy vector
- [ ] Establish a "findings lock" protocol: when a review is in-plan phase, parallel fixers coordinate via the plan's TODO checkboxes to avoid duplicate work
