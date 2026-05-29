# V2 migration setup checklist (companion to upgrading-v1.5-to-v2.md)

This file is the authoritative pre-flight checklist used by the V2-rc test
suite. It also serves as the operator's printable checklist during deploy.

## Required Stripe webhook events (10)

```
[ ] customer.subscription.created
[ ] customer.subscription.updated
[ ] customer.subscription.deleted
[ ] invoice.paid
[ ] invoice.payment_failed
[ ] charge.refunded
[ ] charge.dispute.created
[ ] charge.dispute.funds_withdrawn
[ ] credit_note.created
[ ] customer.deleted
```

> All 10 events MUST be enabled before flipping to strict mode. Missing
> `customer.deleted` keeps a 24h drift gap for Stripe-Dashboard customer
> deletions (RT F7 → Val S4 Q1 fix).

## Required pre-deploy DB migrations

```
[ ] 004_customers
[ ] 005_subscriptions
[ ] 006_subscription_events
[ ] 007_idempotency_records
[ ] 008_runtime_config
[ ] 009_ledger_v2_columns
```

## Backfill (RT F13)

```
[ ] npx paykit backfill-customers --provider stripe-subscription
[ ] verify SELECT COUNT(*) FROM paykit.customers WHERE provider='stripe-subscription'
    matches expected V1.5-tenant count
```

## Canary configuration (Val S4 Q3)

```
[ ] PAYKIT_V2_WEBHOOK_STRICT=false set on V2 deploy
[ ] paykit.runtime_config row 'webhook_strict_v2' present
    with expires_at = deploy_time + 24h
[ ] reconciler scheduled to run within 24h of deploy
[ ] alert wired for WEBHOOK_STRICT_AUTO_FLIPPED log line
```

## Webhook endpoint (RT F7)

```
[ ] POST /webhooks/stripe-subscription wired to buildSubscriptionWebhookHandler
[ ] secret rotation array configured (old + new)
[ ] no shared secret across adapter instances
```

## Admin guard (RT F5)

```
[ ] adminGuard configured in createPaykit()
[ ] admin routes mounted at /admin/billing/subscriptions/*
[ ] Idempotency-Key middleware enforced on POST endpoints
```

## V1.5 regression

```
[ ] V1.5 /webhooks/stripe still 200s on charge events
[ ] V1.5 /admin/billing/refund {transactionId} still works
[ ] V2 /admin/billing/refund-invoice {invoiceId} works (RT F12)
[ ] V1.5 reconciler still runs nightly
```
