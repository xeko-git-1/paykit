# Upgrading from Paykit V1.5 to V2

> Adds Stripe Subscription support via pass-through. V1.5 one-off Checkout
> remains available — both adapters coexist as `stripe` and
> `stripe-subscription`.

**Time-to-upgrade target:** under 1 hour, including customer backfill and
the 24h canary window. The first 5 steps complete in minutes; step 6 is a
24h-wallclock observation period that needs no operator action.

## Prerequisite

V1.5 must already be running stably for ≥2 weeks. Subscription paths assume
`payment_transactions` and `webhook_events` are populated and reconciled.

## 1. Install the V2 adapter

```bash
pnpm add @vibecc/paykit-stripe-subscription
```

The package adds zero-runtime-dep types from `@vibecc/paykit` plus the
`createStripeSubscriptionAdapter` factory.

## 2. Apply migrations 004–009

```bash
npx paykit migrate up
```

| Migration | Purpose |
|---|---|
| 004 | `paykit.customers` (tenant ↔ Stripe customer) |
| 005 | `paykit.subscriptions` cache + UNIQUE (provider, provider_subscription_id) |
| 006 | `paykit.subscription_events` append-only audit (DB trigger + REVOKE) |
| 007 | `paykit.idempotency_records` tenant-scoped 24h replay store |
| 008 | `paykit.runtime_config` for canary auto-flip |
| 009 | `ledger_entries.{provider, source_id}` + UNIQUE for resend dedup |

All additive. Safe to run with V1.5 traffic in flight.

## 3. Backfill `paykit.customers` (RT F13)

```bash
npx paykit backfill-customers --provider stripe-subscription
```

Derives Stripe `customer` ids from prior V1.5 `payment_transactions`
metadata and seeds `paykit.customers`. Re-running is safe — the script is
idempotent (PK on `(tenant_id, provider)`).

Without this step, the first V2 subscribe call for an existing V1.5 tenant
would call `stripe.customers.create` and orphan that tenant's existing
Stripe customer.

## 4. Wire the V2 adapter

```ts
import { createPaykit } from "@vibecc/paykit-server";
import { createStripeAdapter } from "@vibecc/paykit-stripe";
import { createStripeSubscriptionAdapter } from "@vibecc/paykit-stripe-subscription";

const paykit = await createPaykit({
  db,
  tenantResolver,
  adminGuard,                            // REQUIRED for admin routes (RT F5)
  providers: [
    createStripeAdapter({ /* V1.5 one-off */ }),
    createStripeSubscriptionAdapter({   // V2 subscription
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET!,
    }),
  ],
});
```

Both adapters register peer-by-peer. Adapter ids are distinct (`stripe` vs
`stripe-subscription`); the registry rejects collisions.

## 5. Boot the canary toggle (Val S4 Q3)

Set the env var on the deploying instance:

```
PAYKIT_V2_WEBHOOK_STRICT=false
```

On boot, paykit upserts:

```sql
INSERT INTO paykit.runtime_config (key, value, expires_at)
VALUES ('webhook_strict_v2', 'false', now() + INTERVAL '24 hours');
```

Behavior during canary:

* unhandled webhook event types → 200 + `info` log (regression-tolerant)
* refund/dispute/credit-note ledger writes still apply normally

The Phase 07 reconciler flips `value` to `true` and clears `expires_at` on
the first run after the 24h window expires. No operator action needed.
The auto-flip emits `WEBHOOK_STRICT_AUTO_FLIPPED` so it's greppable in logs.

## 6. Configure Stripe webhook endpoint

Add a single endpoint per adapter instance (RT F7):

```
https://<your-host>/webhooks/stripe-subscription
```

Subscribe to the **10 events** listed in `stripe-subscription-setup.md`.

After 24h with no `LEDGER_CURRENCY_MISMATCH` / `STATUS_UNKNOWN` /
`subscription_webhook_tx_failed` warnings, you're at steady state. The
canary auto-flips and standard log levels resume.

## What changed from V1.5

| Topic | V1.5 | V2 |
|---|---|---|
| Payments scope | one-off Stripe Checkout + VN providers | + recurring Stripe Subscription |
| Webhook URLs | one per adapter | one per adapter (RT F7 — already true) |
| Customer mapping | implicit per-transaction | persistent `paykit.customers` row |
| Refunds | `POST /admin/billing/refund {transactionId, ...}` | also accepts `{invoiceId, ...}` (RT F12) |
| Ledger contract | `credit` / `debit` / `refund` / `manual_adjustment` | + `subscription_credit` / `refund_debit` / `dispute_debit` / `credit_note_debit` |
| Reconciler | tx-vs-provider list diff | + ledger sum reconciliation (Val S4 Q2; read-only) |

## Out of scope for V2

- Polar / Lemon Squeezy / Paddle subscriptions (V2.1)
- Multi-currency beyond USD (V2.1+)
- Usage-based / metered billing (V3+)
- Tenant transfer between customer ids (deferred indefinitely)
