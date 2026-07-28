# Paykit

> Drop-in payment kit for TypeScript + Hono + Postgres apps. Bring your own payment-provider accounts; paykit owns the ledger, webhooks, and admin UI.

**Status:** V3 in development (`0.3.0-rc.0`). Not yet published. Update this line on each version bump.

## What it does

- One-off top-ups via SePay (VietQR), Stripe Checkout, the VN providers (VNPay / Momo / ZaloPay), and crypto via NowPayments / BitPay
- Recurring billing via Stripe Subscriptions (V2): customer lifecycle, plan sync, invoice + subscription webhooks
- Multi-wallet ledger: each tenant can hold USD + VND balances side-by-side
- Webhook handlers with signature verify (or fetch-back verification for unsigned-webhook providers like BitPay), transaction-wrapped writes, DB-unique-key dedup, refund support, and graceful expiry handling
- Async refunds: synchronous (Stripe/VNPay/Momo), 2-step polling (ZaloPay), and `pending_webhook` resolution for crypto providers
- Plug-in `discountResolver` for promo codes (race-safe via paykit-invoked `consume(tx)` callback)
- Optional `onBeforeCredit` hook for OFAC/sanctions screening (quarantine without ledger touch)
- Admin React UI (4-tab panel) with `t(key)` i18n hook
- Reconciliation worker that compares paykit's ledger against provider records
- CLI: `paykit migrate` (advisory-locked, multi-instance safe) and `paykit doctor`

## Supported providers

| Provider | Package | Currency | Refund mode |
|---|---|---|---|
| Stripe (one-off) | `@vibecc/paykit-stripe` | USD | sync |
| Stripe Subscriptions | `@vibecc/paykit-stripe-subscription` | USD | via invoice lifecycle |
| SePay (VietQR) | `@vibecc/paykit-sepay` | VND | manual (one-way bank transfer) |
| VNPay | `@vibecc/paykit-vnpay` | VND | sync |
| Momo | `@vibecc/paykit-momo` | VND | sync |
| ZaloPay | `@vibecc/paykit-zalopay` | VND | 2-step async (poll) |
| NowPayments | `@vibecc/paykit-nowpayments` | USD | async (`pending_webhook`) — multi-chain USDT (BEP20/TRC20/ERC20/Polygon) via `payCurrency` |
| Cryptomus | `@vibecc/paykit-cryptomus` | USD | async (`pending_webhook`) — multi-chain USDT, signed webhook (MD5) |
| BitPay | `@vibecc/paykit-bitpay` | USD | async (`pending_webhook`) — refund needs an injected merchant ECDSA signer; not yet sandbox-verified end-to-end |
| Binance Pay | `@vibecc/paykit-binance` | USD | async (`pending_webhook`) — off-chain merchant account; no public sandbox, not yet verified end-to-end |

## What it doesn't do (yet)

- No Polar / Paddle / Creem adapters (planned)
- No multi-currency beyond USD + VND
- Usage-based / metered billing (planned V3+)

## Architecture (locked)

- Core packages: `@vibecc/paykit` (core types), `@vibecc/paykit-server` (Hono + Drizzle), `@vibecc/paykit-workers` (reconciliation), `@vibecc/paykit-react` (admin UI), `@vibecc/paykit-cli` (migrate + doctor)
- Provider adapters ship as separate packages (see the matrix above) — install only the ones you use; each plugs into the generic webhook router with zero core/server changes
- Postgres schema: `paykit.*` (separate database from your app DB — no cross-DB JOIN)
- Tenancy: you implement `TenantResolver` (`{tenantId, ownerId}` from request)
- Secrets: pluggable `SecretProvider` (env / AWS KMS / HashiCorp Vault)
- Migrations triggered from your CI/CD pipeline, never auto-run on app boot

### Two ways to run

- **Embedded (V1–V3):** `import { createPaykit }` into your own Hono app, supply a `TenantResolver`. Quickstart below.
- **Standalone service (V4):** run `@vibecc/paykit-service` as a container — config + API-key auth via env, no app code. Migrate-then-serve cold start, 8 wired adapters (Stripe / SePay / NowPayments / VNPay / Momo / ZaloPay / Cryptomus / Binance Pay; BitPay is embedded-only), `/v1` HTTP API, CLI bootstrap, and a thin TypeScript SDK. See [service-mode-setup.md](docs/service-mode-setup.md).

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

See `docs/`:

- [Installation](docs/installation.md) — setup, DB provisioning, adapter install
- [Integration guide (bilingual EN/VI)](docs/integration-guide.md) — per-provider env vars, multi-chain USDT, new-project setup, i18n
- [Service mode (V4)](docs/service-mode-setup.md) — Docker cold-start, CLI bootstrap, `/v1` API + TypeScript SDK
- [V4 acceptance tests](docs/v4-acceptance-tests.md) — cold-start → bootstrap → mint → checkout checklist
- [Refund flows](docs/refund-flows.md) — per-provider refund capabilities + `pending_webhook` state
- [Stripe subscription setup](docs/stripe-subscription-setup.md) · [V2 setup checklist](docs/v2-setup-checklist.md)
- [Mobile integration](docs/mobile-integration.md) · [Deeplink formats](docs/deeplink-formats.md)
- VN provider sandboxes: [Momo](docs/sandbox-setup-momo.md) · [VNPay](docs/sandbox-setup-vnpay.md) · [ZaloPay](docs/sandbox-setup-zalopay.md)
- Upgrading: [V1 → V1.5](docs/upgrading-v1-to-v1.5.md) · [V1.5 → V2](docs/upgrading-v1.5-to-v2.md)
- Acceptance tests: [V1.5](docs/v1.5-acceptance-tests.md) · [V2](docs/v2-acceptance-tests.md)

## License

Proprietary. See `LICENSE`.

## Repository

`https://github.com/xeko-git-1/paykit` (private)
