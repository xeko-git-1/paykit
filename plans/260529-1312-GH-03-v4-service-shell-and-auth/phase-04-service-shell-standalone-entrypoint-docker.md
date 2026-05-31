---
phase: 4
title: "Service shell — standalone entrypoint + Docker"
status: pending
priority: P1
effort: "5-6h"
dependencies: [3]
---

# Phase 4: Service shell — standalone entrypoint + Docker

> **Red-team applied (2026-05-29):** F2 (webhook auth bypass) → webhooks mount tại
> **top-level `/webhooks/*`, KHÔNG bao giờ dưới `/v1`** (auth glob structurally không
> chạm tới). F5 → service inject resolver **throw**. F14 → `/readyz` ping có timeout +
> cache. F15 → effort 3h→5-6h (serve lifecycle + adapters-from-env đều greenfield).

> **Validation Session 1 (2026-05-29):** D6 → JWT secret từ DB `runtime_config` (KHÔNG env
> `PAYKIT_JWT_SECRET`); bootstrap generate+seed nếu vắng. D5 → single Docker image, serve/
> migrate/doctor/worker là sub-command cùng image (locked).

## Overview

Package mới `packages/service`: bootstrap chạy được standalone (`@hono/node-server`),
import `@vibecc/paykit-server`, wire auth middleware (phase 3) + adapters từ env config,
sở hữu Postgres riêng. Dockerfile + healthcheck. Đây là biến library → deployable service.

## Requirements

**Functional**
- Entrypoint `packages/service/src/main.ts`: tạo pg pool, `createPaykit(...)`. **F2 mount tách path-tree:**
  - `app.route('/webhooks', paykit.webhookRoutes())` ở **top-level** — KHÔNG dưới `/v1`.
  - `app.use('/v1/*', apiKeyAuthMiddleware)` rồi mount `routes()`/`adminRoutes()` dưới `/v1`.
  - Auth glob `/v1/*` cấu trúc KHÔNG thể chạm `/webhooks/*` → provider IPN không bao giờ 401.
  - `serve()` trên `PORT`.
- **F5:** `createPaykit` nhận resolver **throw** `TenantResolutionError` (service mode không có TenantResolver thật; auth là nguồn tenant duy nhất). Kết hợp F2 phase 3 (`tenantResolver` optional) — chọn 1 cách, document.
- Config từ env (D5): `DATABASE_URL`, `PORT`, provider creds (vẫn env cho V4.0 — vault là V4.1). Validate fail-fast bằng zod. **D6 (Validation S1): JWT secret KHÔNG từ env** — đọc/seed từ DB `runtime_config` (xem dưới + phase 3), KHÔNG dùng `PAYKIT_JWT_SECRET`.
- **D6 JWT secret bootstrap:** lúc boot, đọc JWT secret từ `runtime_config`; nếu vắng → generate ≥32 bytes random + insert (advisory-lock tránh race multi-instance, dùng cùng cơ chế `migration-runner`); nếu có nhưng < 32 bytes → fail-fast. Rotation = update row (document thủ công).
- Adapter selection `adapters-from-env.ts`: bật adapter theo env present (vd `STRIPE_SECRET_KEY` → stripe). **Lưu ý (F15): đây là code MỚI** — không có analog env→adapter trong server package để "mirror"; budget như greenfield.
- `GET /healthz` (liveness, **DB-independent** — F14: DB chậm không được restart pod) + `GET /readyz` (DB ping **có timeout 1-2s + cache vài giây + dedicated/cheap `SELECT 1`** — F14: chống cascade khi DB chậm).
- CLI subcommand trong cùng image: `migrate` + `doctor` (reuse `paykit-cli`). Single container, command tách (open Q1).

**Non-functional**
- `packages/service` import `@vibecc/paykit-server` + adapters; KHÔNG copy logic (trừ wiring + adapters-from-env mới).
- Dockerfile multi-stage (build → slim runtime, node:20-alpine), non-root user.
- **F2 structural rule:** webhook path mount trên tree mà auth/rate-limit glob KHÔNG match được.

## Architecture

```
packages/service/
  src/
    main.ts          ← serve() + env validate + wiring
    config.ts        ← zod env schema, fail-fast (JWT secret từ runtime_config — D6, KHÔNG env)
    adapters-from-env.ts ← bật adapter theo env (CODE MỚI — F15)
    health.ts        ← /healthz (no DB) + /readyz (DB ping, timeout+cache — F14)
  Dockerfile         ← multi-stage, non-root
  package.json

Request ─► Hono app
   /healthz                → no auth, NO DB (liveness)
   /readyz                 → no auth, DB ping (timeout 1-2s, cached) — F14
   /webhooks/{adapter}     → TOP-LEVEL, no auth (signature/fetch-back in adapter) — F2
   /v1/* → apiKeyAuthMiddleware → requireScope → handler   (glob KHÔNG chạm /webhooks)
   /v1/admin/*             → (V4.0: vẫn adminGuard env-based; dashboard JWT là V4.4)
```

## Related Code Files

- **Create:** `packages/service/package.json` (`@hono/node-server` dep — NEW, chưa có trong repo), `src/main.ts`, `src/config.ts`, `src/adapters-from-env.ts`, `src/health.ts`
- **Create:** `packages/service/Dockerfile`, `packages/service/.dockerignore`
- **Create:** `docker-compose.yml` (root, dev: service + postgres) — config file, không cần modularize
- **Modify:** root `package.json` workspace nếu cần (pnpm workspace tự nhận `packages/*`)
- **Create (TEST FIRST):** `packages/service/__tests__/config-validation.test.ts`, `packages/service/__tests__/app-wiring.test.ts`, `packages/service/__tests__/webhook-route-isolation.test.ts`

## Implementation Steps (TDD)

1. **RED:**
   - `config-validation.test.ts` — thiếu `DATABASE_URL` → throw fail-fast; **D6: JWT secret từ `runtime_config` vắng → generate+seed; có nhưng < 32 bytes → fail** (KHÔNG đọc env `PAYKIT_JWT_SECRET`); env đủ → parse OK.
   - `app-wiring.test.ts` — `/healthz` 200 no-auth không cần DB; `/v1/balances` không key → 401; `/v1` vắng paykitAuth (resolver throw) → 401 không leak (F5).
   - **`webhook-route-isolation.test.ts` (F2 — defense-in-depth):** enumerate mọi route đã mount, assert KHÔNG path webhook nào nằm dưới prefix bị auth/rate-limit; `POST /webhooks/sepay` KHÔNG 401/429.
   Dùng `app.fetch(Request)` không cần listen. Chạy → FAIL.
2. **GREEN:** implement config.ts (zod, secret-length) + adapters-from-env + main wiring (webhook top-level — F2) + health (readyz timeout+cache — F14). Tách `buildServiceApp()` khỏi `serve()` để test fetch app không mở socket.
3. Viết Dockerfile multi-stage + docker-compose dev.
4. **VERIFY:** `pnpm --filter @vibecc/paykit-service build && pnpm vitest run packages/service` → PASS. `docker build` thành công; `docker compose up` → `/healthz` 200, `/readyz` 200 sau khi pg sẵn sàng. Synthetic signed IPN → `/webhooks/sepay` trả 2xx (KHÔNG 401) — deploy-smoke.

## Success Criteria

- [ ] Config test: thiếu env critical → fail-fast; **D6: JWT secret từ `runtime_config` (vắng→seed, <32B→fail), KHÔNG đọc env**
- [ ] `/healthz` 200 no-auth **không phụ thuộc DB**; `/readyz` có timeout, không hang khi DB chậm (F14)
- [ ] `/v1/*` không key → 401; `/v1` vắng paykitAuth → 401 (F5)
- [ ] **F2:** `/webhooks/*` top-level, route-isolation test xác nhận KHÔNG nằm dưới auth/rate-limit; IPN không 401/429
- [ ] App curl được từ ngoài (any-lang) chỉ bằng API key — chứng minh portability
- [ ] `docker build` xanh; container non-root; `docker compose up` healthy

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F2: webhook dưới `/v1` lọt auth glob → provider IPN 401 → mất tiền âm thầm | Med | **Critical** | Mount webhook TOP-LEVEL; route-isolation test enumerate; deploy-smoke synthetic IPN |
| F5: service mode fallback resolver fail-open → cross-tenant | Med | **Critical** | Inject resolver THROW; `/v1` vắng auth → 401 (phase 3) |
| F14: `/readyz` ping unbounded → cascade removal khi DB chậm | Med | High | Timeout 1-2s + cache + `SELECT 1`; `/healthz` tách khỏi DB |
| Env secret rò qua log/crash dump | Med | High | zod parse không echo value; redaction helper (`core/observability/redaction`) wire vào log |
| Provider creds qua env không scale multi-merchant | High | Med (defer) | V4.0 single-creds-per-deploy; multi-merchant = V4.1 vault. Document |
| Docker image phình / chạy root | Low | Med | Multi-stage + alpine + `USER node` |

## Security Considerations

- **PCI lock (D8):** service không có endpoint nhận PAN; checkout chỉ tạo redirect/token URL. Tài liệu hóa rõ trong README service.
- `/healthz` `/readyz` không auth nhưng KHÔNG leak version/secret/DB DSN.
- Container non-root; secret chỉ qua env/secret-manager, không bake vào image.
