---
title: "Paykit V4.0 — Service shell + Auth (API key + JWT)"
description: "Pivot paykit từ embedded library (TS+Hono+Postgres) sang standalone service + thin SDK. V4.0 = keystone: thay TenantResolver bằng API-key auth + merchants table, JWT plane cho dashboard, public /v1 API + OpenAPI, Docker shell."
status: completed
priority: P1
branch: "feat/v3-phase-03-nowpayments-adapter"
tags: [v4, re-arch, service, auth, api-key, jwt, openapi, docker, security]
blockedBy: [260529-1117-GH-03-bitpay-adapter-and-nowpayments-refund-fix]
blocks: []
created: "2026-05-29T07:09:03.612Z"
createdBy: "ck:plan"
source: skill
---

# Paykit V4.0 — Service shell + Auth (API key + JWT)

> **Mode:** `--tdd` (tests-first mỗi phase). **Keystone security-critical.**
> Brainstorm gốc (approved): `plans/reports/brainstorm-260529-1312-GH-03-paykit-service-sdk-rearch-report.md`

## Overview

V4.0 là **keystone** của re-arch "Service + SDK": biến paykit từ thư viện nhúng (host
phải dùng Hono + tự inject `TenantResolver`/`SecretProvider`/`events`) thành **service
độc lập** mà app bất kỳ ngôn ngữ gọi qua HTTP + API key.

Phạm vi V4.0 **chỉ** đụng 1 trong 4 điểm host-injection: **`TenantResolver` → API-key
auth + bảng `merchants`**. Ledger / adapter / reconciliation core **giữ nguyên ~95%** —
DB đã tách sẵn (`paykit.*` schema riêng app DB) nên service hóa là "đổi cách gọi"
(in-process → HTTP), không phải rewrite.

**Ngoài scope V4.0** (defer): credential vault (V4.1), webhook-out (V4.2), currency
registry (V4.3), SDK gen + dashboard standalone (V4.4).

## Quan hệ thứ tự (QUAN TRỌNG)

Đây là **plan-on-paper**. Thứ tự *implement* thực tế: **V3 close-out (publish `0.3.0`)
TRƯỚC**, V4.0 sau. Plan này khóa định hướng trong khi V3 ship. `blockedBy` plan V3 vì:
1. **Publish-gating:** không phân tán effort khi V3 chưa publish `0.3.0`; service đóng gói server đã ổn định.
2. Tránh churn migration/manifest khi V3 còn đang sửa.

> **Cập nhật (red-team verified 2026-05-29):** migration **011** (`refund_pending_webhook`)
> ĐÃ commit trên branch này (`1a7aeeb`) — `manifest.json` đã có entry 001–011. Lý do
> `blockedBy` KHÔNG còn là "chờ V3 thêm 011" (đã có); chỉ còn publish-gating ở trên.
> V4.0 bắt đầu migration **012**.

## Key architectural decisions (locked trong brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | Auth **2 plane**: API key (server↔server) + JWT (dashboard/frontend) | User chốt. Tách cứng: s2s không bao giờ dùng JWT; frontend không bao giờ thấy API key |
| D2 | API key lưu **hashed** (sha256), prefix `pk_live_`/`pk_test_` | Theo chuẩn Stripe; DB leak không lộ key dùng được |
| D3 | `merchant_id` = `tenantId` = `ownerId` cho V4.0 | Sub-account/team deferred. Giữ ledger schema bất biến |
| D4 | Auth = Hono middleware, mirror `adminGuardMiddleware` | Pattern đã có (`admin-guard.ts`); set tenant vào `c` context |
| D5 | Service shell = **package mới** `packages/service`, import `@xeko-git-1/paykit-server` | Giữ server là library; service chỉ là deployable shell + bootstrap |
| D6 | JWT V4.0 = verify middleware + mint helper + plane-separation only | Dashboard login flow đầy đủ defer V4.4 — tránh over-build |
| D7 | Rate-limit in-memory per-key cho V4.0; Redis path documented, defer | KISS single-instance; multi-instance là V4.x |
| D8 | **PCI lock:** service KHÔNG BAO GIỜ nhận PAN/thẻ — chỉ token/redirect | Sai = rơi PCI-DSS đầy đủ. Khóa từ design |

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Schema and migration 012 (merchants + api_keys)](./phase-01-schema-and-migration-012-merchants-api-keys.md) | Completed |
| 2 | [API-key auth primitives — mint/hash/verify/scope](./phase-02-api-key-auth-primitives-mint-hash-verify-scope.md) | Completed |
| 3 | [Auth middleware — API-key + JWT planes replacing TenantResolver](./phase-03-auth-middleware-api-key-jwt-planes-replacing-tenantresolver.md) | Completed |
| 4 | [Service shell — standalone entrypoint + Docker](./phase-04-service-shell-standalone-entrypoint-docker.md) | Completed |
| 5 | [Public /v1 API surface + OpenAPI + rate-limit](./phase-05-public-v1-api-surface-openapi-rate-limit.md) | Completed |

## Sequencing rationale

- **01 keystone:** schema + migration là nền; phase 2-3 cần bảng `api_keys` tồn tại.
- **02 trước 03:** primitives (mint/hash/verify) là unit thuần, test cô lập trước khi
  ghép vào middleware (Hono request lifecycle).
- **03 thay TenantResolver:** điểm refactor rủi ro nhất — TDD lock hành vi tenant-scoping
  hiện có trước khi đổi nguồn tenant từ `req` → API key.
- **04 sau auth:** service shell mount middleware đã test; không bootstrap service "trần".
- **05 cuối:** `/v1` + OpenAPI là mặt ngoài, ổn định nhất khi auth + shell đã xong.

## Cross-cutting constraints

- **TDD:** mỗi phase viết test FAIL trước, code cho PASS. **F9:** test tenant-scoping
  KHÔNG được chỉ assert HTTP 200 — scoping thực thi trong repo SQL (`…ByTenant(db, tenantId)`),
  fake-DB mock nó đi; test phải assert repo mock gọi đúng `tenantId`, hoặc dùng real-Postgres
  2-tenant. Migration-shape test theo `v2-migrations-shape.test.ts`.
- **Security:** phase 2-3-5 nên kèm `/ck:security` threat-model TRƯỚC khi code (auth, mint,
  refund). Timing-safe compare cho key verify; không log key plaintext.
- **Backward compat (F2):** `tenantResolver` trở thành **OPTIONAL** trên `PaykitConfig` +
  route-builder deps — đây là interface change **backward-compatible** (thêm optional, không
  bỏ required cũ): embedded consumer truyền resolver như cũ vẫn chạy; service mode bỏ resolver,
  dùng auth. Invariant: đúng một trong {tenantResolver, apiKey-auth} được wire. KHÔNG phá
  embedded giữa lúc V3 vừa publish.

## Dependencies

- **blockedBy:** `260529-1117-GH-03-bitpay-adapter-and-nowpayments-refund-fix` — **publish-gating**
  (không phân tán effort tới khi V3 publish `0.3.0`). KHÔNG còn là dependency migration-numbering.
- **F1 + F12 (red-team verified):** migration cao nhất hiện tại đã là **011**
  (`refund_pending_webhook`, committed `1a7aeeb`). V4.0 bắt đầu **012**. Migration manifest là
  `packages/cli/migrations/manifest.json` (entry id/slug/up/down/description — **KHÔNG checksum**);
  `release-manifest.json` ở root là file ClaudeKit tooling, KHÔNG liên quan DB migration.
- Reuse: `migration-runner.ts` (advisory-lock + `schema_migrations` theo `id`, **không checksum**),
  `adminGuardMiddleware` pattern, vitest harness, biome lint.

## Open questions

> **Tất cả 6 đã RESOLVED trong Validation Session 1 (2026-05-29) — xem `## Validation Log`.**

1. **[D5 packaging]** ✅ RESOLVED → single container, serve/migrate/doctor/worker là sub-command cùng image.
2. **[D6 JWT]** ✅ RESOLVED → JWT secret lưu DB `runtime_config` (migration 008), KHÔNG env. Rotation qua DB.
3. **[D3 tenancy]** Defer: tách `ownerId` ≠ `merchant_id` (sub-merchant) khi có yêu cầu marketplace thật.
4. **[F8 OpenAPI]** ✅ RESOLVED → `@hono/zod-openapi` (`OpenAPIHono`+`createRoute`) — **chấp nhận rewrite route**. Verify zod-v4.4.3 peer-compat TRƯỚC khi thêm dep (blocking gate).
5. **[F11 subscriptions]** ✅ RESOLVED → **scope OUT V4.0**, document "subscriptions chỉ embedded mode". KHÔNG migrate subscription routes ở phase 3.
6. **[D2 mode]** ✅ RESOLVED → `mode` (live/test) là **label, non-isolated**; document rõ. KHÔNG enforce reject test key, KHÔNG bỏ cột.

## Red Team Review

### Session — 2026-05-29
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer (3, scaled for 5 phases)
**Findings:** 16 (15 accepted, 1 rejected)
**Severity breakdown:** 4 Critical, 5 High, 6 Medium (+1 rejected)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Wrong manifest file (`release-manifest.json`) + nonexistent checksum gate → 012 never registers, tests stay green | Critical | Accept | Phase 1 |
| 2 | Webhooks mounted "dưới /v1" + auth on `/v1/*` → provider IPN 401 → silent money loss | Critical | Accept | Phase 4 |
| 3 | `/v1/api-keys` mint takes arbitrary scopes + body `merchantId` → privilege escalation + cross-tenant key minting | Critical | Accept | Phase 5, 2 |
| 4 | `/v1/refunds` reuse → admin route has NO tenant filter on tx lookup → cross-tenant refund IDOR | Critical | Accept | Phase 5 |
| 5 | `tenantResolver` required + dual-source fallback = fail-open; D5 "pure import" needs optional-resolver change | High | Accept | Phase 3, 4 |
| 6 | JWT verify: no alg pin, no `alg:none`/HS-RS reject, no secret-strength/iss/aud | High | Accept | Phase 3, 4 |
| 7 | Admin refund coupled to `adminGuard`+`adminContext` → needs extraction, not wrap | High | Accept | Phase 5 |
| 8 | OpenAPI-from-zod fiction: hand-rolled routes, unexported schema, generator dep absent, zod-v4 peer risk | High | Accept | Phase 5 |
| 9 | Fake-DB characterization test can't prove tenant scoping (scoping in repo SQL) | High | Accept | Phase 3 |
| 10 | Down-migration DROP merchants+api_keys → rollback destroys live keys, mass 401 | High | Accept | Phase 1 |
| 11 | Phase 3 Modify-list omits subscriptions routes that also use resolver | Medium | Accept | Phase 3 |
| 12 | `blockedBy` rationale stale (011 already exists) → reframe to publish-gating | Medium | Accept | plan.md |
| 13 | New `/v1` DTO no `zod.strict()` + no PAN-reject test → D8 PCI untested | Medium | Accept | Phase 5 |
| 14 | In-memory rate-limit as mint control but Docker scales → bypass; `/readyz` unbounded ping → cascade | Medium | Accept | Phase 4, 5 |
| 15 | Effort 16h optimistic; P4/P5 net-new scope → realistic ~22-26h | Medium | Accept | Phase 4, 5, plan |
| 16 | sha256 no-salt for API keys | (n/a) | **Reject** | — (rationale sound for high-entropy keys; confirmed by reviewer) |

**Effort revised:** P1 3h, P2 3h, P3 ~5h, P4 5-6h, P5 6-8h → **~22-26h** (was 16h).

### Whole-Plan Consistency Sweep
- Migration numbering reconciled across plan.md + phase 1: highest existing = **011**; V4 starts **012**; manifest = `migrations/manifest.json` (no checksum). Stale "010 ceiling / V3 adds 011 / release-manifest checksum" claims removed everywhere.
- `blockedBy` rationale changed to publish-gating in both plan.md §"Quan hệ thứ tự" and §Dependencies.
- Webhook mount rule unified: top-level `/webhooks/*` (phase 4 F2), referenced by phase 3 webhook-risk row and phase 5 rate-limit constraint — no contradiction.
- Tenant fail-closed (phase 3 F5) consistent with phase 4 throwing-resolver injection.
- `tenantResolver` optional (F2) stated in plan §Cross-cutting + phase 3 Related Code Files + phase 4 — consistent.
- Refund: phase 5 "extract core, not wrap" (F7) + ownership check (F4) consistent; admin route characterization preserved.
- No remaining references to "drop table" down-migration, "checksum", or "fallback resolver on /v1". **Zero unresolved contradictions.**

## Validation Log

### Session 1 — 2026-05-29
**Verification Pass:** SKIPPED — `## Red Team Review` đã có evidence `file:line` đầy đủ (guard điều kiện); không còn `[UNVERIFIED]` tag. 6 câu hỏi (2 đợt).

| # | Question | Decision | Implication |
|---|----------|----------|-------------|
| 1 | [F8] OpenAPI build | **`@hono/zod-openapi` (rewrite route)** | ⚠️ Khác khuyến nghị plan (zod-to-openapi). Tăng scope phase 5: rewrite route sang `OpenAPIHono`+`createRoute`. **Blocking gate:** verify zod-v4.4.3 peer-compat TRƯỚC khi thêm dep — nếu incompatible, dừng + escalate |
| 2 | [F11] Subscriptions | **Scope OUT V4.0 + document** | Phase 3 KHÔNG migrate `subscriptions/tenant-routes.ts` + `idempotency-middleware.ts`; document "subscriptions = embedded mode only" trong V4.0. Giảm blast radius |
| 3 | [D2] mode live/test | **Document non-isolated** | Giữ cột `mode`; document rõ "label, không tách data ở V4.0". KHÔNG enforce reject test key, KHÔNG bỏ cột |
| 4 | [D5] Packaging | **Single image, command tách** | Phase 4: 1 Docker image, serve/migrate/doctor/worker là sub-command |
| 5 | [D6] JWT secret | **Lưu DB `runtime_config`** (KHÔNG env) | ⚠️ Khác khuyến nghị plan (env). Đổi nguồn secret phase 3+4: đọc từ `runtime_config` (migration 008 đã có), generate+seed lúc bootstrap nếu vắng, rotation qua DB. Bỏ yêu cầu `PAYKIT_JWT_SECRET` env |
| 6 | [F14] Mint DB cap | **Thêm per-merchant DB-counted cap V4.0** | ⚠️ Khác khuyến nghị plan (defer). Phase 5: thêm logic đếm key/merchant (durable, multi-instance-safe) — durable cap bù cho rate-limit in-memory không authoritative |

**Decisions khác khuyến nghị (user override — guard theo review-audit-self-decision rule):** #1, #5, #6. Đều tăng scope; user xác nhận chủ động. Đã propagate, KHÔNG tự đảo ngược.

### Whole-Plan Consistency Sweep (post-validation)
- **F8 #1:** phase 5 Open Q (a/b) → chốt (b) `@hono/zod-openapi`; cập nhật Requirements + risk "rewrite route" thành quyết định, thêm zod-v4 verify gate.
- **F11 #2:** phase 3 Related Code Files + Success Criteria → subscriptions OUT (xóa nhánh "migrate"); plan §Open Q5 resolved.
- **D2 #3:** phase 1 + plan D2 → giữ cột `mode`, thêm note non-isolated.
- **D5 #4:** phase 4 → single image (đã đề xuất sẵn, nay locked).
- **D6 #5:** phase 3 (jwt-middleware) + phase 4 (config) → secret từ `runtime_config` thay env; bỏ `PAYKIT_JWT_SECRET` env + check độ dài env. Giữ yêu cầu secret ≥32B nhưng nguồn = DB.
- **F14 #6:** phase 5 → mint thêm DB-counted cap; risk row cập nhật.
- Sau propagate: re-grep stale terms → reconcile. **Zero unresolved contradictions** (xem propagation phase files).
