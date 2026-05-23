# Upgrading Paykit V1 → V1.5

## Breaking changes

V1.5 extracts Stripe and SePay into their own npm packages. V1 user upgrading to V1.5 MUST install 2 new packages:

```bash
pnpm add @vibecc/paykit-stripe @vibecc/paykit-sepay
```

If you forget, paykit's factory throws a clear migration error at boot:

> Legacy `providers: { stripe }` shape requires `pnpm add @vibecc/paykit-stripe`.

## Two upgrade paths

### Path 1 — Zero code changes (legacy shape)

Keep your V1 `createPaykit({ providers: { stripe, sepay } })` call. Paykit's
backward-compat shim lazy-imports the adapter packages.

```ts
// V1 code — unchanged after V1.5 upgrade IF you `pnpm add` the 2 new packages
const paykit = await createPaykit({
  db,
  tenantResolver,
  providers: {
    stripe: { secretKey, webhookSecret, successUrl, cancelUrl },
    sepay: { apiKey, secretKey, accountNumber, accountName, bankBin },
  },
});
```

**Note:** `createPaykit` is now `async` (returns `Promise<Paykit>`). V1 callers using the synchronous shape will get a TS error. Wrap with `await`.

### Path 2 — V1.5 array shape (recommended)

Migrate to the new adapter array. This is required when adding a 3rd provider (VNPay/Momo/ZaloPay).

```ts
import { createPaykit } from "@vibecc/paykit-server";
import { createStripeAdapter } from "@vibecc/paykit-stripe";
import { createSepayAdapter } from "@vibecc/paykit-sepay";
import { createVnpayAdapter } from "@vibecc/paykit-vnpay";
import { createMomoAdapter } from "@vibecc/paykit-momo";
import { createZaloPayAdapter } from "@vibecc/paykit-zalopay";

const paykit = await createPaykit({
  db,
  tenantResolver,
  providers: [
    createStripeAdapter({ secretKey, webhookSecret, successUrl, cancelUrl }),
    createSepayAdapter({ apiKey, secretKey, accountNumber, accountName, bankBin }),
    createVnpayAdapter({ tmnCode, hashSecret, returnUrl, ipnUrl }),
    createMomoAdapter({ partnerCode, accessKey, secretKey, returnUrl, ipnUrl }),
    createZaloPayAdapter({ appId, key1, key2, returnUrl, callbackUrl }),
  ],
});
```

## DB migrations

V1.5 adds 2 new migrations: 002 (`internal_id` column) + 003 (`pending_refunds` table).

```bash
DATABASE_URL_PAYKIT="..." npx paykit migrate up
```

Both migrations are additive. 001 → 002 → 003 is safe on V1 production data.

## Webhook URLs

V1.5 changes from per-provider routes to dynamic `/webhooks/{providerId}`:

- V1: `POST /webhooks/stripe`, `POST /webhooks/sepay`
- V1.5: `POST /webhooks/{adapter.id}` — same URLs work for V1 adapters because `id='stripe'`, `id='sepay'`

For new adapters: `POST /webhooks/vnpay`, `/webhooks/momo`, `/webhooks/zalopay`.

In each provider's dashboard, set webhook URL to the matching path.

## Refund API change

V1.5 introduces `POST /admin/billing/refund` with **required** `Idempotency-Key` header.

```ts
fetch("/admin/billing/refund", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    transactionId: "<paykit-tx-uuid>",
    amountMicros: "10000000",
    reason: "customer dispute",
  }),
});
```

Same `Idempotency-Key` → returns same result (cached). Use UUID per attempt.

V1's manual `/admin/billing/ledger/adjust` still works for SePay (which has no refund API).

## Reconciliation

V1's `reconcile()` signature with separate fetcher args still works. V1.5 adds `reconcileV15(deps, opts)` which uses the registry — recommended for new projects.

```ts
import { reconcileV15 } from "@vibecc/paykit-workers";

const result = await reconcileV15(
  { db: paykitDb, registry: paykit.registry },
  { since: new Date(Date.now() - 24 * 60 * 60 * 1000) },
);
console.log(result.status); // 'completed' | 'partial' | 'failed'
```

## Mobile deeplink

If your app is web + native mobile, see `docs/mobile-integration.md` for iOS Universal Links + Android App Links setup.

## Time-to-upgrade target

A V1 user following this guide should complete the upgrade in **< 30 minutes**:

1. `pnpm add @vibecc/paykit-stripe @vibecc/paykit-sepay` (2 min)
2. `await` the `createPaykit` call (2 min)
3. `npx paykit migrate up` (2 min)
4. Verify webhook URLs unchanged in Stripe/SePay dashboards (5 min)
5. Run `npx paykit doctor` to validate (1 min)
6. Deploy + smoke test 1 top-up (15 min)

If you encounter issues, check `docs/troubleshooting.md`.
