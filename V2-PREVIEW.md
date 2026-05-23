# V2 Subscription Billing — Roadmap Placeholder

> Status: **NOT IMPLEMENTED in V1**. This document captures the V1→V2 boundary and what V2 will add.

V1 ships **one-off top-ups only** via SePay (VietQR) + Stripe Checkout `mode: "payment"`. Subscription billing is deferred to V2.

## V2 Scope (planned, NOT in V1)

### V2.0 — Stripe Subscription Core

- New tables: `paykit.subscription_plans`, `paykit.subscriptions`, `paykit.subscription_events`
- New routes: `POST /billing/subscriptions`, `GET /billing/subscriptions/:id`, `POST /billing/subscriptions/:id/cancel`
- New webhook event types in `/webhooks/stripe`:
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`
- Stripe `Customer` lifecycle (lazy-create on first subscription, link via `tenantId`)
- Stripe `Price` + `Product` sync — consumer defines plans in their app, paykit syncs to Stripe
- Recurring webhook idempotency (extends `webhook_events` PK pattern unchanged)
- Plan switching with prorations
- Trial periods
- Cancellation policies (immediate vs end-of-period)

### V2.1 — Polar adapter

- `PolarClient` mirroring `StripeClient` shape
- Subscription via Polar (different webhook event names + payload shape)
- Side-by-side coexistence with Stripe

### V2.2 — Multi-currency expansion beyond USD/VND

- Currency table for zero-decimal vs decimal currencies (JPY, KRW)
- Per-tenant currency preference

### Cross-cutting (V2)

- React `<SubscriptionPanel>` admin component
- React `<SubscriptionStatus>` tenant-facing widget
- CLI `paykit subscriptions sync` command
- `paykit.workers.reconcileSubscriptions({since})` in `@vibecc/paykit-workers`

## V1→V2 Boundary Guards (enforced in V1 CI)

Located in `packages/core/__tests__/v1-boundary-guards.test.ts`. Forbidden patterns in V1 source:

- `mode: "subscription"` (regex)
- `Stripe.Subscription`, `Stripe.Customer`, `Stripe.Price`, `Stripe.Product` types
- `subscription_plans` / `subscriptions` table references
- `promoCodeRepo`, `promo_codes` (V1 uses `discountResolver` hook only)
- VibeCC-specific terms: `workspace_id`, `organization_id`, `creditPool`

If you're adding V2 code, REMOVE the relevant pattern from `FORBIDDEN_PATTERNS` in `v1-boundary-guards.test.ts` AS PART OF the V2 work.

## When to Start V2

V1 must be GA-stable for **at least 1 week of production use** before V2 work begins:

- [ ] V1 published `0.1.x` series stabilized to `1.0.0` (no breaking changes for 7+ days)
- [ ] At least 1 external project successfully integrated V1
- [ ] No P0/P1 bugs open
- [ ] Time-to-integrate target met (< 1 hour) with cold teammate test

## V2 Open Questions (resolve at V2 plan time)

1. Polar vs Paddle vs Creem — which provider gets V2.1 priority?
2. Subscription state machine ownership — paykit-side state vs trust Stripe as source-of-truth?
3. Trial logic — paykit-managed vs Stripe-managed?
4. Backwards compat — do subscriptions and top-up coexist or are they exclusive per tenant?
5. Refund handling — V1 has `charge.refunded`; V2 adds invoice refunds via subscription lifecycle?
6. Will VibeCC self-migrate to paykit at V2 GA, or stay on its in-tree code?

## V2 Schema Migration Discipline

Migrations 002+ MUST be additive only — never break V1 tables. If a breaking change is required, document the upgrade path in this file BEFORE adding the migration.

This file is committed to `paykit/V2-PREVIEW.md` (NOT inside `packages/`) so V1 build artifacts don't ship the V2 outline.
