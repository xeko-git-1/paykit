# Paykit Installation Guide

## Prerequisites

- Node.js ≥ 20
- pnpm 10
- **Two separate Postgres databases**:
  1. Your app's DB (existing)
  2. **Paykit's dedicated DB** — paykit owns its own Postgres database, NOT a schema in your app DB
- A Stripe account (one per consumer project)
- A SePay account (if accepting VND via VietQR)
- GitHub Personal Access Token with `read:packages` scope (to install from GitHub Packages)

## Step 1 — Configure GitHub Packages auth

Create `.npmrc` in your project root:

```
@vibecc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Set `GITHUB_TOKEN` env var to a PAT with `read:packages`.

## Step 2 — Install

```bash
pnpm add @vibecc/paykit @vibecc/paykit-server @vibecc/paykit-react
pnpm add -D @vibecc/paykit-cli
```

**V3 crypto adapters** (install only the providers you need):

```bash
pnpm add @vibecc/paykit-nowpayments   # NowPayments — 200+ crypto assets, USD settlement, async refund via webhook
pnpm add @vibecc/paykit-bitpay        # BitPay — fiat-priced crypto invoices, USD settlement, unsigned-webhook fetch-back verification
```

## Step 3 — Provision the paykit Postgres database

```bash
createdb paykit_prod   # or however you provision DBs
```

Set env var:

```bash
DATABASE_URL_PAYKIT="postgres://user:pass@host:5432/paykit_prod"
```

## Step 4 — Run migrations

```bash
npx paykit migrate up
```

This creates the `paykit` schema and 5 tables inside the paykit DB.

## Step 5 — Wire createPaykit in your app

```ts
import { createPaykit } from "@vibecc/paykit-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

const paykitClient = new Client({ connectionString: process.env.DATABASE_URL_PAYKIT });
await paykitClient.connect();
const paykitDb = drizzle(paykitClient);

const paykit = createPaykit({
  db: paykitDb,
  tenantResolver: async (req) => {
    const user = await getCurrentUser(req); // YOU implement
    return { tenantId: user.id, ownerId: user.orgId ?? user.id };
  },
  providers: {
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      successUrl: "https://yourapp.com/billing/success",
      cancelUrl: "https://yourapp.com/billing/checkout",
    },
    sepay: {
      apiKey: process.env.SEPAY_API_KEY!,
      secretKey: process.env.SEPAY_SECRET_KEY!,
      accountNumber: process.env.SEPAY_ACCOUNT_NUMBER!,
      accountName: process.env.SEPAY_ACCOUNT_NAME!,
      bankBin: process.env.SEPAY_BANK_BIN!,
      brandPrefix: "MYAPP", // optional, defaults to "PAYKIT"
    },
  },
  adminGuard: async (req) => {
    const user = await getCurrentUser(req);
    if (user?.role !== "admin") return { allowed: false };
    return { allowed: true, adminUserId: user.id, role: user.role };
  },
  events: {
    onPaymentCompleted: (tx) => analytics.track("payment.completed", tx),
    onPaymentRefunded: (tx, refundAmount) =>
      analytics.track("payment.refunded", { tx, refundAmount }),
  },
});

app.route("/billing", paykit.routes());           // checkout, balance, ledger
app.route("/webhooks", paykit.webhookRoutes());   // /webhooks/sepay + /webhooks/stripe
app.route("/admin/billing", paykit.adminRoutes()); // admin endpoints (requires adminGuard)
```

## Step 6 — Configure Stripe webhook URL

In Stripe Dashboard → Developers → Webhooks:

- Endpoint URL: `https://yourapp.com/webhooks/stripe`
- Events: `checkout.session.completed`, `charge.refunded`, `checkout.session.expired`

## Step 7 — Configure SePay webhook

In SePay Dashboard:

- Webhook URL: `https://yourapp.com/webhooks/sepay`
- HMAC signature header: `x-sepay-signature`

## Step 8 — Run doctor

```bash
npx paykit doctor
```

Expected output:

```
✓ db_reachable           Postgres connection OK
✓ paykit_schema          paykit schema exists
✓ paykit_tables          all 5 paykit tables present
✓ db_isolation           DB appears dedicated to paykit
✓ provider_env           all provider env vars set
```

## Step 9 — React UI

```tsx
import { PaykitBalanceWidget, PaykitAdminPanel } from "@vibecc/paykit-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

function MyApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <PaykitBalanceWidget apiBase="/billing" t={i18n.t} />
      {user.isAdmin && <PaykitAdminPanel apiBase="/admin/billing" t={i18n.t} />}
    </QueryClientProvider>
  );
}
```

## Schedule the reconciliation worker

```ts
import { reconcile, createStripeFetcher, createSepayFetcher } from "@vibecc/paykit-workers";
import Stripe from "stripe";

// Run via cron / BullMQ / Cloudflare Cron — NOT a long-running daemon.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const result = await reconcile(
  {
    db: paykitDb,
    stripeFetcher: createStripeFetcher(stripe),
    sepayFetcher: createSepayFetcher(async (window) => {
      // YOU implement — fetch from SePay HTTP API
      return [];
    }),
  },
  { since: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // 24h window
);
console.log(result.summary);
```

## Troubleshooting

- `paykit doctor` warns "non-paykit schemas detected" → verify `DATABASE_URL_PAYKIT` points to a dedicated DB, not your app DB.
- Stripe webhook 401 → check `STRIPE_WEBHOOK_SECRET` matches what Stripe shows in the Dashboard. Rotate by passing array to `webhookSecret: [old, new]`.
- BigInt errors in JSON → paykit returns micros as strings; never `JSON.stringify(BigInt)`. Use `formatMicros()` in React.
