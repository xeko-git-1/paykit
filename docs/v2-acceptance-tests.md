# V2 Acceptance Tests

> Phase 10 of the V2 implementation plan. Pattern follows V1.5 — specs are
> documented here and gated on Stripe sandbox credentials. Companion E2E
> harness lives at `e2e/consumer-app` (added in a separate plan).

## Status

V2 ships **9 phase complete + 10 phase docs**. Live Stripe-sandbox spec
execution requires:

- `STRIPE_TEST_SECRET_KEY` registered as a GitHub Action secret
- `STRIPE_TEST_WEBHOOK_SECRET` (or rotation array) registered
- Postgres testcontainer for DB-touching specs (reuses V1.5 harness)
- AdminGuard implementation in the consumer-app for admin-route specs

## Spec coverage (20 V2 specs, IDs 31–50)

| # | Spec | Phase | RT/Val ref | Gate |
|---|---|---|---|---|
| 31 | stripe-sub-create-active | 03, 05 | F8 | sandbox |
| 32 | stripe-sub-trial-then-active | 03, 06 | — | sandbox + test clock |
| 33 | stripe-sub-cancel-end-of-period | 03, 05 | — | sandbox |
| 34 | stripe-sub-cancel-immediate | 03, 05 | — | sandbox |
| 35 | stripe-sub-upgrade-prorate | 03, 05 | — | sandbox |
| 36 | stripe-sub-webhook-paid-ledger-credit | 06 | F1 | sandbox |
| 37 | stripe-sub-webhook-failed | 06 | — | sandbox |
| 38 | stripe-sub-out-of-order-events | 06 | F9 | always (mocked) |
| 39 | stripe-sub-reconciler-cache-drift | 07 | F2, F14 | sandbox |
| 40 | customer-lazy-create-idempotent | 04 | F4 | sandbox |
| 41 | idempotency-key-required-on-mutating | 05 | F6 | always |
| 42 | cross-tenant-no-info-leak | 05 | F11 | always |
| 43 | charge-refunded-ledger-debit | 06 | F1 | sandbox |
| 44 | charge-dispute-funds-withdrawn-ledger-debit | 06 | F1 | sandbox |
| 45 | invoice-paid-resend-no-double-credit | 06 | F1 | always (mocked) |
| 46 | admin-cancel-without-guard-rejected | 05 | F5 | always |
| 47 | refund-by-invoice-tenant-validation | 08 | F12 | always (mocked) |
| 48 | backfill-script-idempotent | 09 | F13 | always |
| 49 | customer-deleted-cascade-cancel | 06 | Val S4 Q1 | sandbox |
| 50 | ledger-reconciler-flags-drift | 07 | Val S4 Q2 | sandbox |

## Currently covered by unit + route + handler tests

These specs are covered by tests in this repo today:

- 38 (out-of-order events): `subscription-webhook-handler.test.ts` last-write-wins
- 41 (idempotency-key required): `subscription-routes.test.ts` 4 cases
- 42 (cross-tenant 404 + ledger): `subscription-routes.test.ts` GET 404 + Idempotency-Key isolation
- 45 (resend dedup): `subscription-webhook-handler.test.ts` ledger UNIQUE blocks second credit
- 46 (admin guard reject): `subscription-routes.test.ts` AdminGuard 403
- 47 (refund tenant validation): server invoice-refund route — INVOICE_NOT_FOUND when no sub holds latestInvoiceId
- 48 (backfill idempotent): `backfill-customers.test.ts` idempotent re-run
- 49 (customer.deleted cascade): `subscription-webhook-handler.test.ts` cascade test
- 50 (ledger drift flags): `reconcile-subscriptions.test.ts` Pass B drift cases

## CI matrix (V2 additions)

```yaml
jobs:
  always-on:
    name: CI (no creds)
    steps:
      - run: pnpm install
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      # Runs all V1+V1.5+V2 unit specs that don't need Stripe sandbox

  sandbox-stripe-subscription:
    name: Stripe Subscription sandbox CI
    if: ${{ secrets.STRIPE_TEST_SECRET_KEY != '' }}
    timeout-minutes: 15  # Val S4 Q4
    steps:
      - run: pnpm test:e2e --filter=@vibecc/paykit-stripe-subscription
        env:
          STRIPE_TEST_SECRET_KEY: ${{ secrets.STRIPE_TEST_SECRET_KEY }}
          STRIPE_TEST_WEBHOOK_SECRET: ${{ secrets.STRIPE_TEST_WEBHOOK_SECRET }}
```

CI runtime budget is **15 minutes** (Val S4 Q4 — accounts for Stripe test
clocks driving trial/period transitions plus webhook delivery latency).
Earlier proposals to parallelize past `maxThreads=4` were dropped because
shared Stripe test account rate limits create flakiness.

## V1 + V1.5 regression

All V1 specs (1–19) and V1.5 specs (20–30) MUST still pass with V2 code.
The V2 SubscriptionAdapter is registered alongside V1.5 adapters in the
ProviderRegistry; the adapter ids are distinct (`stripe` vs
`stripe-subscription`) so registration cannot collide.

## Publish workflow

`v0.2.0-rc.0` tag publishes 11 packages:

| Package | Version |
|---|---|
| @vibecc/paykit | 0.2.0-rc.0 |
| @vibecc/paykit-server | 0.2.0-rc.0 |
| @vibecc/paykit-stripe | 0.1.5-alpha.1 (unchanged) |
| @vibecc/paykit-sepay | 0.1.5-alpha.1 (unchanged) |
| @vibecc/paykit-vnpay | 0.1.5-alpha.1 (unchanged) |
| @vibecc/paykit-momo | 0.1.5-alpha.1 (unchanged) |
| @vibecc/paykit-zalopay | 0.1.5-alpha.1 (unchanged) |
| @vibecc/paykit-stripe-subscription | 0.2.0-rc.0 |
| @vibecc/paykit-workers | 0.2.0-rc.0 |
| @vibecc/paykit-react | 0.2.0-rc.0 |
| @vibecc/paykit-cli | 0.1.5-alpha.1 (unchanged) |

After 7 consecutive days of green sandbox CI, tag `v0.2.0` for GA.

## Sandbox-only spec authoring guide

For specs gated on sandbox credentials, the harness in `e2e/consumer-app/`
will follow the V1.5 pattern:

```ts
import { test, expect } from "vitest";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_TEST_SECRET_KEY!);

test.skipIf(!process.env.STRIPE_TEST_SECRET_KEY)(
  "31: subscribe creates active sub + ledger credit on invoice.paid",
  async () => {
    const customer = await stripe.customers.create({ email: "test@example.com" });
    const product = await stripe.products.create({ name: "Test" });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1000,
      currency: "usd",
      recurring: { interval: "month" },
    });

    const res = await fetch(`${baseUrl}/billing/subscriptions`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ priceId: price.id }),
    });
    expect(res.status).toBe(201);
    // Wait for webhook delivery, assert ledger entry...
  },
);
```

Stripe test clocks (32, 39) require:

```ts
const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: Math.floor(Date.now() / 1000),
});
// later: stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: t + 7*86400 });
```
