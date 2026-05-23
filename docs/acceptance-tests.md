# Paykit V1 — Acceptance Test Plan

> Status: scaffolded; live execution requires credentials.

This document lists the 19 in-monorepo acceptance specs, the external-repo install spec, and the live-smoke spec for `0.1.0` GA.

## Scaffolding (in this repo)

- `e2e/consumer-app/` — Hono app wiring paykit via local file dep
- `e2e/external-repo-install/` — separate `.npmrc`-based install test (TODO: set up companion repo)
- `e2e/live-smoke/` — pre-publish $0.50 charge against `paykit-smoke` Stripe account (TODO: provision)

## In-Monorepo Acceptance Specs (19)

| # | Spec | Status |
|---|---|---|
| 01 | stripe-topup-usd | TODO: requires testcontainer Postgres + Stripe test keys |
| 02 | sepay-topup-vnd | TODO: requires testcontainer + SePay sandbox |
| 03 | multi-wallet-coexist | TODO: same tenant tops up USD + VND independently |
| 04 | stripe-refund | TODO: charge.refunded → debit ledger entry |
| 05 | checkout-expired | TODO: mark pending tx as expired |
| 06 | bad-signature | TODO: webhook with wrong sig → 401 |
| 07 | duplicate-event | TODO: same event twice → silent skip |
| 08 | idempotency-key-checkout | TODO: same Idempotency-Key → existing pending tx |
| 09 | discount-race-loser-pays-full | TODO: 2 concurrent checkouts → 1 wins discount |
| 10 | reconciliation | TODO: paykit.workers.reconcile writes reconciliation_runs row |
| 11 | balance-read-per-currency | TODO: GET /balance returns USD + VND rows |
| 12 | ledger-pagination | TODO: 100 entries → page through limit=10 |
| 13 | admin-list | TODO: 403 when guard denies; cross-tenant when allows |
| 14 | admin-adjust | TODO: ledger insert + balance applyDelta atomic |
| 15 | admin-ui-render-with-t-prop | TODO: <PaykitAdminPanel> renders 4 tabs |
| 16 | tenant-as-user | TODO: TenantResolver returns userId-as-tenant; works |
| 17 | tenant-as-org | TODO: TenantResolver returns orgId-as-tenant; works |
| 18 | no-cross-db-join | TODO: verify paykit code never queries app DB connection |
| 19 | ci-smoke | TODO: full pipeline `migrate up → top-up → balance` < 5 min |

## External-Repo Install Test (1)

| Spec | Status |
|---|---|
| install-and-smoke (separate repo `xeko-git-1/paykit-test-consumer`) | TODO: provision companion repo, configure NPM_TOKEN with read:packages, install @vibecc/paykit@0.1.0, run minimal smoke |

## Live-Smoke Test (1, pre-publish only)

| Spec | Status |
|---|---|
| live-stripe-topup ($0.50 against `paykit-smoke` Stripe account) | TODO: provision `paykit-smoke` Stripe account, store STRIPE_LIVE_SECRET_KEY in GitHub repo secrets, gate behind release tag workflow |

## Credential Setup Checklist (consumer / operator)

These secrets must be configured before V1 GA tag:

| Secret | Where | Used for |
|---|---|---|
| `STRIPE_SECRET_KEY` (test) | GitHub Actions | CI specs 01, 04, 05, 08 |
| `STRIPE_WEBHOOK_SECRET` (test) | GitHub Actions | CI specs 04, 06, 07 |
| `STRIPE_LIVE_SECRET_KEY` (paykit-smoke account) | GitHub Actions | live-smoke pre-publish |
| `SEPAY_API_KEY` + `SEPAY_SECRET_KEY` (sandbox) | GitHub Actions | CI spec 02 |
| `NPM_TOKEN` (read:packages) | external repo `.npmrc` | external-repo install spec |
| `DATABASE_URL_PAYKIT_TEST` (testcontainer URL) | CI per-job | all DB-touching specs |

## V1 GA Gate

All 19 + 1 external + 1 live-smoke must pass GREEN in CI for the tag that becomes `0.1.0` GA. Until then, releases are `0.1.0-rc.x`.

## Phase 13 dependency

V1 GA also requires Phase 13's 7-day SLO measurement window (≥ 99.9% on `paykit-smoke`) and KMS rotation drill. See `phase-13-observability-secrets-slo.md` in the VibeCC plan repo.
