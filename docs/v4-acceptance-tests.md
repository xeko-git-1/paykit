# V4.0 acceptance tests

Living checklist for the V4.0 service-operability release. Mirrors the success
criteria of plan `260531-2213-GH-03-v40-service-operability-docker-sdk`. Each
item is gated by a test or a verified manual step.

## Auth end-to-end (Phase 1)

- [x] Migration adds `api_keys.created_by` (ALTER, nullable) — 13-table count unchanged
- [x] `paykit merchant create` prints a merchant_id
- [x] `paykit apikey mint` prints a `pk_…` key once + records `created_by=cli:operator`
- [x] CLI mint enforces the per-merchant cap (10) — identical to the HTTP route
- [x] Unknown scope / missing merchant / cap reached → clear rejection
- [x] `paykit jwt mint` produces an admin JWT that verifies against the runtime secret
- [x] Both auth planes coexist on `/v1/*` (token-prefix dispatcher): api-key → s2s
      routes; JWT → `POST /v1/api-keys`; neither plane rejects the other's tokens
- [x] `POST /v1/api-keys` reachable with an admin JWT (was dead before — JWT plane unmounted)

## VN adapters (Phase 2)

- [x] VNPay / Momo / ZaloPay enabled when all of each provider's creds present
- [x] Any missing field for a provider → that provider stays disabled (no crash)
- [x] Service wires 6 adapters total
- [x] Dockerfile copies all 6 adapter packages (both build stages)

## Docker cold-start (Phase 3)

- [x] `docker compose up` on a fresh volume: migrate init applies all migrations, exits 0
- [x] `service` starts only after migrate succeeds (`service_completed_successfully`)
- [x] `/healthz` 200 and `/readyz` 200 after cold start
- [x] `paykit doctor` reports all **13** tables (was hardcoded "5")
- [x] doctor flags a missing table (e.g. `reconciliation_runs`) instead of false-OK
- [x] Service image runs `serve` only; migrations run via the CLI bin (no execSync DSN)
- [x] Full bootstrap flow verified through the container: merchant → key → checkout

## TypeScript SDK (Phase 4)

- [x] `openapi-typescript` parses the OpenAPI 3.1 spec (blocking gate)
- [x] `createPaykitClient` covers checkouts / balances / payments / refunds, type-safe
- [x] Checkout uses the real DTO (`amountVnd` for SePay; never `amountMicros`/`currency`)
- [x] Auth header attached automatically; error envelope → `PaykitApiError` with code
- [x] SDK does NOT expose key minting (`/v1/api-keys` filtered from the snapshot)
- [x] Spec-snapshot drift guard compares the committed snapshot to the live service spec
- [x] No runtime dependencies (types generated at build time; transport is `fetch`)

## Docs + e2e gate (Phase 5)

- [x] `service-mode-setup.md` covers Docker, env, bootstrap, `/v1`, SDK, migrate-recovery
- [x] `installation.md` table count corrected 5 → 13; links to service mode
- [x] README reflects the embedded-vs-service split
- [x] E2E (real Postgres): cold-start → bootstrap → mint → checkout(`amountVnd`) → 2xx
- [x] E2E negatives: missing scope → 403, no key → 401
- [x] CI job on `postgres:16` gates the cold-start path (migrate + serve + `/v1`)

## Deferred

- [ ] Extract `@vibecc/paykit-auth-core` so the CLI no longer imports `@vibecc/paykit-server`
      (the boundary test is currently skipped) — see
      `plans/260531-2213-GH-03-v40-service-operability-docker-sdk/phase-06-extract-auth-core.md`

## How to run the e2e locally

```bash
docker run -d --name pg -e POSTGRES_USER=paykit -e POSTGRES_PASSWORD=paykit \
  -e POSTGRES_DB=paykit -p 55433:5432 postgres:16-alpine
PAYKIT_E2E_DATABASE_URL="postgres://paykit:paykit@localhost:55433/paykit" \
  pnpm vitest run packages/service/__tests__/service-cold-start.e2e.test.ts
docker rm -f pg
```

Without `PAYKIT_E2E_DATABASE_URL` the e2e suite skips automatically.
