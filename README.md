# Paykit

> Drop-in payment kit for TypeScript + Hono + Postgres apps. Bring your own Stripe + SePay accounts; paykit owns the ledger, webhooks, and admin UI.

**Status:** V1 development. Not yet published.

## What it does

- One-off top-ups via SePay (VietQR) + Stripe Checkout one-time payments
- Multi-wallet ledger: each tenant can hold USD + VND balances side-by-side
- Webhook handlers with signature verify, transaction-wrapped writes, DB-unique-key dedup, refund support, and graceful expiry handling
- Plug-in `discountResolver` for promo codes (race-safe via paykit-invoked `consume(tx)` callback)
- Admin React UI (4-tab panel) with `t(key)` i18n hook
- Reconciliation worker that compares paykit's ledger against Stripe + SePay records
- CLI: `paykit migrate` (advisory-locked, multi-instance safe) and `paykit doctor`

## What it doesn't do (V1)

- No Stripe Subscription billing (planned V2)
- No Polar / Paddle / Creem (planned V2+)
- No multi-currency beyond USD + VND (V2)

## Architecture (locked)

- 5 npm packages: `@vibecc/paykit` (core types), `@vibecc/paykit-server` (Hono + Drizzle), `@vibecc/paykit-workers` (reconciliation), `@vibecc/paykit-react` (admin UI), `@vibecc/paykit-cli` (migrate + doctor)
- Postgres schema: `paykit.*` (separate database from your app DB — no cross-DB JOIN)
- Tenancy: you implement `TenantResolver` (`{tenantId, ownerId}` from request)
- Secrets: pluggable `SecretProvider` (env / AWS KMS / HashiCorp Vault)
- Migrations triggered from your CI/CD pipeline, never auto-run on app boot

## Quickstart (preview — V1 not yet published)

```bash
pnpm add @vibecc/paykit @vibecc/paykit-server @vibecc/paykit-react
pnpm add -D @vibecc/paykit-cli
```

```ts
import { createPaykit } from "@vibecc/paykit-server";

const paykit = createPaykit({
  db,                                   // your paykit-DB Drizzle client
  schema: "paykit",
  tenantResolver: (req) => ({ tenantId: req.user.id, ownerId: req.user.orgId ?? req.user.id }),
  providers: {
    stripe: { secretKey, webhookSecret, successUrl, cancelUrl },
    sepay:  { apiKey, secretKey, accountNumber, accountName, bankBin },
  },
});

app.route("/billing",       paykit.routes());
app.route("/webhooks",      paykit.webhookRoutes());
app.route("/admin/billing", paykit.adminRoutes());
```

## Documentation

See `docs/` (will be authored in Phase 11).

## License

Proprietary. See `LICENSE`.

## Repository

`https://github.com/xeko-git-1/paykit` (private)
