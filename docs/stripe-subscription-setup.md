# Stripe Subscription setup — 10 webhook events

Configure exactly one endpoint per `stripe-subscription` adapter instance
(RT F7). Sharing a webhook URL across Stripe accounts breaks per-instance
signature isolation.

## Endpoint URL

```
POST https://<your-host>/webhooks/stripe-subscription
```

If you run multiple instances (deferred to V2.1, not used in V2), each
instance owns its own URL: `/webhooks/stripe-subscription:eu`,
`/webhooks/stripe-subscription:us`, etc.

## Required events (10 total)

| # | Stripe event | Paykit normalized type | Effect |
|---|---|---|---|
| 1 | `customer.subscription.created` | `sub.created` | upsert cache row |
| 2 | `customer.subscription.updated` | `sub.updated` | upsert cache (last-write-wins, RT F9) |
| 3 | `customer.subscription.deleted` | `sub.deleted` | mark canceled |
| 4 | `invoice.paid` | `invoice.paid` | append `subscription_credit` ledger entry |
| 5 | `invoice.payment_failed` | `invoice.failed` | mark `past_due` |
| 6 | `charge.refunded` | `charge.refunded` | append `refund_debit` |
| 7 | `charge.dispute.created` | `charge.dispute.created` | audit-only (no ledger move) |
| 8 | `charge.dispute.funds_withdrawn` | `charge.dispute.funds_withdrawn` | append `dispute_debit` |
| 9 | `credit_note.created` | `credit_note.created` | append `credit_note_debit` |
| 10 | `customer.deleted` (Val S4 Q1) | `customer.deleted` | cascade-cancel active/trialing/past_due subs |

## Webhook secret rotation

Pass an array to `createStripeSubscriptionAdapter`:

```ts
createStripeSubscriptionAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: [
    process.env.STRIPE_WEBHOOK_SECRET_OLD,  // verifies in-flight payloads
    process.env.STRIPE_WEBHOOK_SECRET_NEW,  // primary going forward
  ].filter(Boolean) as string[],
});
```

Each instance verifies against its own pool only. There is no global
secret list — instance EU's secret cannot validate instance US's payloads.

## Ledger semantics

- `invoice.paid` writes a `subscription_credit` row only when `currency='usd'`,
  `amount_paid > 0`, and the subscription is not canceled with a late
  invoice (period_end ≤ canceled_at).
- Refund / dispute / credit-note write a `*_debit` row keyed by their
  Stripe object id (charge.id, dispute.id, credit_note.id).
- The ledger row is keyed by UNIQUE `(provider, source_id, entry_type)` to
  block double-writes if Stripe resends with a new `event_id`.

## Verification

```bash
# in dev, after wiring everything
stripe trigger customer.subscription.created
stripe trigger invoice.paid
stripe trigger charge.refunded
stripe trigger customer.deleted

# expect:
# - 200 from /webhooks/stripe-subscription
# - rows in paykit.subscriptions
# - rows in paykit.subscription_events
# - rows in paykit.ledger_entries (where applicable)
```

If you don't see `customer.deleted` in the supported event list when
configuring Stripe, you're looking at outdated docs.
