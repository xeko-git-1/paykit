# Service mode setup (V4)

Run Paykit as a standalone container — configured entirely through environment
variables and an API key, with no application code. This is the alternative to
the embedded mode in [installation.md](./installation.md).

> Embedded mode (`createPaykit` + your own `TenantResolver`) is unchanged. Service
> mode only adds a new deployment path; it does not alter the embedded API.

## What you get

- **Cold-start Docker**: `docker compose up` on a fresh volume migrates the
  schema, then serves — in that order, automatically.
- **6 wired adapters**: Stripe, SePay, NowPayments, VNPay, Momo, ZaloPay — each
  enabled only when its credentials are present.
- **`/v1` HTTP API**: scope-gated, rate-limited, OpenAPI-described.
- **CLI bootstrap**: create the first merchant + API key without the service running.
- **Thin TypeScript SDK** (`@vibecc/paykit-sdk`): type-safe client over `/v1`.

## Prerequisites

- Docker + Docker Compose
- A Postgres database dedicated to Paykit (the compose file provisions one)

## 1. Cold start with Docker Compose

The repository's `docker-compose.yml` defines three services: `postgres`, a
one-shot `migrate` init container, and `service`.

```bash
docker compose up
```

Ordering (guaranteed by `depends_on`):

1. `postgres` becomes healthy.
2. `migrate` runs `paykit migrate up` (applies all migrations) and exits 0.
3. `service` starts only after `migrate` succeeds (`service_completed_successfully`).

Migrations are applied by the CLI binary directly (the service image itself only
runs `serve` — it never migrates on boot). The `migrate` container has
`restart: on-failure`; `service` deliberately has no restart policy so a crash
loop surfaces rather than being masked.

Verify:

```bash
curl localhost:3000/healthz   # {"status":"ok"}
curl localhost:3000/readyz    # {"status":"ready"}
```

## 2. Environment reference

`DATABASE_URL` is required. Each provider is enabled only when **all** of its
fields are set; partial credentials leave that provider disabled (no crash).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres DSN (required). Drives both migrate and serve. |
| `PORT` | HTTP port (default 3000). |
| `ADMIN_SECRET` | Enables `/v1/admin/*` via `X-Admin-Secret` (optional). |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | Stripe |
| `SEPAY_API_KEY`, `SEPAY_SECRET_KEY`, `SEPAY_ACCOUNT_NUMBER`, `SEPAY_ACCOUNT_NAME`, `SEPAY_BANK_BIN` | SePay (VietQR) |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `NOWPAYMENTS_ENVIRONMENT?` | NowPayments (crypto) |
| `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_RETURN_URL`, `VNPAY_IPN_URL`, `VNPAY_ENVIRONMENT?` | VNPay |
| `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`, `MOMO_SECRET_KEY`, `MOMO_RETURN_URL`, `MOMO_IPN_URL`, `MOMO_ENVIRONMENT?` | Momo |
| `ZALOPAY_APP_ID`, `ZALOPAY_KEY1`, `ZALOPAY_KEY2`, `ZALOPAY_RETURN_URL`, `ZALOPAY_CALLBACK_URL`, `ZALOPAY_ENVIRONMENT?` | ZaloPay |

VN provider sandboxes: [Momo](./sandbox-setup-momo.md) ·
[VNPay](./sandbox-setup-vnpay.md) · [ZaloPay](./sandbox-setup-zalopay.md).
The JWT signing secret is **not** an env var — it is generated and stored in the
`runtime_config` table on first use.

## 3. Bootstrap the first merchant + key

The mint endpoint (`POST /v1/api-keys`) requires the admin (JWT) plane, so the
first credential must come from the operator CLI, which talks to the DB directly
(the DB URL is a tier-0 operator secret). These commands do **not** require the
service to be running.

```bash
# 1. Create a merchant (prints the merchant_id)
paykit merchant create --name "Acme Co" --db-url "$DATABASE_URL"

# 2. Mint an API key (plaintext is shown ONCE — store it now)
paykit apikey mint --merchant <merchant_id> \
  --scopes "checkout:write,balance:read,payments:read,refund:write" \
  --db-url "$DATABASE_URL"

# 3. (Optional) Mint a short-lived admin JWT to call POST /v1/api-keys over HTTP
paykit jwt mint --merchant <merchant_id> --ttl 900 --db-url "$DATABASE_URL"
```

Inside the running compose stack you can invoke the CLI via the migrate image:

```bash
docker compose run --rm --entrypoint node migrate \
  packages/cli/dist/bin/paykit.js merchant create --name "Acme Co"
```

> **Secret hygiene:** the plaintext API key and JWT are printed to stdout exactly
> once and are not recoverable. Run these interactively. Avoid piping their stdout
> into centralized logs; if a secret leaks, revoke and re-mint immediately.

Scopes are validated against the canonical set and the per-merchant active-key
cap (10) is enforced identically to the HTTP route.

## 4. Call the API

```bash
# SePay is a VND provider → use amountVnd (NOT amountMicros/currency)
curl -X POST localhost:3000/v1/checkouts \
  -H "Authorization: Bearer pk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"provider":"sepay","amountVnd":50000}'

curl localhost:3000/v1/balances  -H "Authorization: Bearer pk_live_..."
curl localhost:3000/v1/payments  -H "Authorization: Bearer pk_live_..."
```

`POST /v1/refunds` additionally requires an `Idempotency-Key` header (≥ 8 chars).
The OpenAPI spec is public at `GET /v1/openapi.json`.

## 5. TypeScript SDK

```ts
import { createPaykitClient } from "@vibecc/paykit-sdk";

const pk = createPaykitClient({
  baseUrl: "https://pay.example.com",
  apiKey: "pk_live_...",
});

// SePay = VND → amountVnd
const { data } = await pk.checkouts.create({ provider: "sepay", amountVnd: 50_000 });
const balances = await pk.balances.get();
const payments = await pk.payments.list({ limit: 50, offset: 0 });
await pk.refunds.create(
  { transactionId, amountMicros: "1000000", reason: "duplicate charge" },
  { idempotencyKey: "refund-0001" },
);
```

The SDK covers the api-key plane only. Key minting is the admin (JWT) plane and is
intentionally absent from the SDK surface.

## Migrate-recovery runbook

If `migrate` fails partway, each migration commits in its own transaction, so the
schema is left at the last fully-applied migration (never half-applied). To recover:

1. Inspect: `paykit migrate status --db-url "$DATABASE_URL"`.
2. Fix the underlying cause (DB connectivity, a bad migration).
3. Re-run `paykit migrate up` — already-applied migrations are skipped; it resumes
   from the first pending one. The runner holds a Postgres advisory lock, so
   concurrent runners block rather than racing.
4. `service` will not start until `migrate` exits 0, so requests are never served
   against an incomplete schema.

Confirm schema health any time with `paykit doctor` (expects 14 business tables).
