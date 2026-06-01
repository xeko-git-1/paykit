---
title: "Paykit V4.0 — Service operability: cold-start Docker, CLI bootstrap, VN adapters, TS SDK"
description: "Đóng last-mile để paykit-service chạy ok từ cold start qua Docker: merchant repo + CLI bootstrap (giải chicken-egg mint key), wire 3 ví VN vào service, docker-compose migrate-then-serve, thin TS SDK từ OpenAPI, docs service-mode + e2e acceptance."
status: completed
priority: P1
branch: "feat/v3-phase-03-nowpayments-adapter"
tags: [v4, service, docker, cli, bootstrap, vn-adapters, sdk, openapi, operability]
blockedBy: []
blocks: []
created: "2026-05-31T15:19:46.698Z"
createdBy: "ck:plan"
source: skill
---

# Paykit V4.0 — Service operability: cold-start Docker, CLI bootstrap, VN adapters, TS SDK

## Overview

V4.0 phase 1-5 (plan `260529-1312`) đã xong: auth API-key+JWT, schema merchants/api_keys,
`/v1` surface (checkout/balance/payments/refund/mint + OpenAPI + rate-limit), service shell,
Docker image. 733 test pass. **Nhưng service chưa khởi động được từ cold start** — 5 gap
operability chặn lời hứa "drop vào app khác + config qua Docker":

1. **Bootstrap chicken-egg + JWT plane chưa wire (chặn cứng):** không có merchant repo / cách
   tạo merchant + key đầu tiên. **Red-team F3:** sâu hơn — `jwtAuthMiddleware` KHÔNG được mount
   vào service (`main.ts:78` chỉ có api_key plane); mint `/v1/api-keys` đòi `requirePlane("jwt")`
   (`router.ts:285`) → endpoint **chết vĩnh viễn** trong service mode. Cần wire JWT + CLI bootstrap.
2. **Compose không migrate (chặn cứng):** `docker-compose.yml` chỉ `command: ["serve"]`. DB
   tươi → bảng chưa có → serve lên nhưng mọi query fail. **Red-team F1/F2:** exec-form ENTRYPOINT
   nuốt CMD + `paykit` bin off PATH → migrate-then-serve không chạy được như viết.
3. **Service chỉ wire 3/8 adapter:** Stripe/SePay/NowPayments. "VN methods qua Docker" hiện
   chỉ = SePay. Thiếu VNPay/Momo/ZaloPay.
4. **doctor hardcode "5 tables":** thực tế **13 bảng** (12 migration; 001_init tạo nhiều bảng
   gồm `reconciliation_runs`). Báo sai.
5. **Không docs service-mode + chưa verify docker build thật.**

Quyết định user (validation 2026-05-31 + red-team 2026-06-01): **+3 ví VN** (service thành 6
adapter), **thin TS SDK** từ OpenAPI, **CLI bootstrap** (`merchant create` + `apikey mint` +
`jwt mint`), **wire JWT plane** (F3 — mint HTTP hoạt động, không để dead-code).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Auth end-to-end: merchant repo, CLI bootstrap, wire JWT plane](./phase-01-merchant-repo-cli-bootstrap-merchant-create-apikey-mint.md) | ✅ Completed |
| 2 | [VN wallet adapters in service (VNPay/Momo/ZaloPay)](./phase-02-vn-wallet-adapters-in-service-vnpay-momo-zalopay.md) | ✅ Completed |
| 3 | [Docker cold-start (migrate then serve) + doctor table-count fix](./phase-03-docker-cold-start-migrate-then-serve-doctor-table-count-fix.md) | ✅ Completed |
| 4 | [Thin TS SDK generated from OpenAPI](./phase-04-thin-ts-sdk-generated-from-openapi.md) | ✅ Completed |
| 5 | [Service-mode docs + end-to-end acceptance](./phase-05-service-mode-docs-end-to-end-acceptance.md) | ✅ Completed |
| 6 | [Extract @vibecc/paykit-auth-core (deferred boundary fix)](./phase-06-extract-auth-core.md) | ⏸ Deferred |

## Implementation outcome (2026-06-01)

Phases 1–5 implemented, cooked, and verified end-to-end. Full suite: **849 passed,
5 skipped** (4 e2e gated by `PAYKIT_E2E_DATABASE_URL`, 1 boundary test deferred to
phase 6). Repo-wide typecheck clean. Docker cold-start verified for real
(migrate→serve, `/healthz`+`/readyz` 200, bootstrap→mint→checkout through the
container); e2e verified against a real throwaway Postgres.

### Deviations from plan (surfaced + decided during cook)

1. **Migration numbered 014, not 013.** A concurrent stream landed
   `013_idempotency_key_tenant_scoped` mid-session, taking the `013` slot the plan
   assumed was free. User decision: renumber the attribution migration to
   `014_api_keys_created_by` (after idempotency). 13-table count unchanged (ALTER only).
2. **F3 solved via a token-prefix dispatcher.** The api-key and jwt middlewares are
   mutually exclusive (each 401s the other's token shape), so they can't be chained
   with `app.use`. Added `authPlaneDispatcher` routing `pk_*`→api-key, else→jwt.
   Verified live: JWT-plane `POST /v1/api-keys` returns 200 (was a dead endpoint).
3. **Three pre-existing cold-start bugs found by real verification** (all masked by
   mock-DB tests + no real-DB e2e — the F14 gap):
   - cac 6.7.14 silently no-ops multi-word command names (`"migrate up"`) → migrate
     applied nothing yet exited 0. Fixed via bracketed sub-arg form (`"migrate <action>"`).
   - `loadEnv` only read `DATABASE_URL_PAYKIT`; compose sets `DATABASE_URL`. Added
     `DATABASE_URL` as lowest-priority fallback (paykit-specific names still win).
   - `drizzle(pool)` built without `{ schema }` → `db.query.*` undefined → `/v1/balances`
     500. Fixed by exporting `paykitDbSchema` and passing it; also fixed CLI `main`
     field (pointed at the bin, not the library barrel).
4. **CLI↔server boundary deferred to phase 6.** Phase 1 (F5) has the CLI import
   server auth primitives + repos, which violates the checked-in `no-cross-imports`
   rule. User chose to extract `@vibecc/paykit-auth-core` as a separate phase; the
   boundary test is `it.skip`-ped with a pointer to phase 6.

## Sequencing rationale

- **01 keystone:** giải chicken-egg là điều kiện cần cho mọi acceptance test sau. Không có
  merchant + key thì không gọi được `/v1` → không verify được gì.
- **02 độc lập:** wire adapter thuần config, không phụ thuộc 01; làm song song được.
- **03 sau 01:** cold-start e2e cần `merchant create` (từ 01) để chứng minh luồng migrate →
  bootstrap → mint → checkout chạy.
- **04 sau 03:** SDK generate từ `/v1/openapi.json` — spec phải ổn định (đã có từ phase 5
  cũ); SDK chỉ là client, sinh sau khi surface khóa.
- **05 cuối:** docs + acceptance phủ toàn bộ 01-04.

## Cross-cutting constraints

- **Branch:** tiếp tục trên `feat/v3-phase-03-nowpayments-adapter` (user đã chốt bỏ V3-publish-gating).
- **YAGNI:** KHÔNG thêm sub-merchant/marketplace; merchant = tenant 1:1 (D3 plan cũ giữ nguyên).
- **Security:** CLI mint in plaintext key 1 lần ra stdout (không log file). `merchant create`
  không nhận scope tùy ý qua env. PCI lock giữ nguyên: service không nhận PAN.
- **Backward compat:** embedded mode (`createPaykit` + tenantResolver) KHÔNG đổi. Mọi thay đổi
  chỉ thêm vào service/cli path.
- **Test:** mỗi phase có test; cold-start (03) + e2e (05) ưu tiên real-Postgres qua docker-compose.

## Dependencies

- **Reuse:** `mintApiKey` (`auth/api-key.ts:75`), `apiKeyRepo.insert/countActiveByMerchant`
  (`db/repos/api-key.repo.ts`), `merchants` schema (`db/schema/merchants.ts`), `SCOPES`
  (`auth/scope.ts:13`), `migration-runner` (advisory-lock), `cac` CLI framework
  (`cli/src/bin/paykit.ts`), VN adapter factories (`createVnpayAdapter`/`createMomoAdapter`/
  `createZaloPayAdapter`), `@hono/zod-openapi` spec đã serve tại `/v1/openapi.json`.
- **New migration 013 (F10 + Validation S1):** thêm cột `api_keys.created_by` để audit ai mint
  key (attribution). merchants + api_keys đã có (012); 013 là ALTER thêm cột. Max migration hiện
  tại = 012 → 013 là kế tiếp. Cần mirror `migrations/` + `packages/cli/migrations/` + 2 manifest.

## Open questions

1. **[Phase 1]** ✅ RESOLVED → CLI thao tác DB trực tiếp qua `--db-url` (giống migrate), KHÔNG
   cần service up. Dùng Drizzle handle (`withDb`), không raw pg.Client (F5).
2. **[Phase 4]** ✅ RESOLVED (Validation S1) → SDK generator = **`openapi-typescript` types-only +
   wrapper tay** (không runtime dep). Blocking gate: verify parse OpenAPI 3.1 trước commit (F15).
3. **[Phase 1, F3]** ✅ RESOLVED (user) → **wire JWT plane** vào service (mount CẢ api_key + jwt
   trên `/v1/*`, pass-through theo dạng token); mint HTTP hoạt động. CLI `jwt mint` cầu admin JWT
   (dashboard login defer V4.4).
4. **[Phase 1, F10 attribution]** ✅ RESOLVED (Validation S1) → **thêm cột `created_by` ngay +
   migration 013** (audit ai mint key). CLI `--merchant` cross-tenant: trust boundary = DB-URL
   tier-0 operator secret (document).

## Red Team Review

### Session — 2026-06-01
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer (3, scaled for 5 phases)
**Findings:** 15 (14 accepted, 1 rejected) — deduped từ 24 raw findings
**Severity breakdown:** 3 Critical, 5 High, 6 Medium (+1 rejected)
**Reports:** `reports/from-code-reviewer-to-planner-red-team-{security-adversary,failure-mode-analyst,assumption-destroyer}-plan-review-report.md`

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | ENTRYPOINT exec-form không bị CMD override → `node main.js sh -c ...` → "Unknown command" → cold-start chết | Critical | Accept | Phase 3 |
| 2 | `paykit` bin không trong runtime PATH → `execSync("paykit migrate")` fail → migrate không chạy | Critical | Accept | Phase 3 |
| 3 | JWT plane chưa wire (`main.ts:78`) → mint `/v1/api-keys` (`requirePlane("jwt")` router.ts:285) chết vĩnh viễn → CLI là đường mint duy nhất | Critical | Accept | Phase 1, plan |
| 4 | Checkout DTO contract sai: thật `{amountUsd?,amountVnd?,provider,discountCode?}` .strict() (dto.ts:19-24), không `{amountMicros,currency}` | High | Accept | Phase 4, 5 |
| 5 | CLI `withClient` trả raw pg.Client; repo cần Drizzle `DbOrTx` (api-key.repo.ts:23) → crash; thiếu dep drizzle-orm | High | Accept | Phase 1 |
| 6 | doctor: **13 bảng** không phải 12/5 (thiếu reconciliation_runs, 001_init) → "fix" để lại false-negative | High | Accept | Phase 3, 5 |
| 7 | `--frozen-lockfile` (Dockerfile:25,74) + dep mới không regenerate lockfile → docker build fail | High | Accept | Phase 1, 2 |
| 8 | Plaintext key → stdout → docker/CI logs (phase 3 mint qua `docker compose exec`) | High | Accept | Phase 1, 5 |
| 9 | `execSync` nội suy `DATABASE_URL` chưa escape (main.ts:133-135) → shell injection lúc boot | High | Accept | Phase 3 |
| 10 | CLI `--merchant <uuid>` mint cross-tenant + bypass per-merchant cap (router.ts:302) + không attribution | Medium | Accept | Phase 1 |
| 11 | SDK generate từ spec gồm mint route (openapi.ts:81-93) → SDK expose mint, trái D1 | Medium | Accept | Phase 4 |
| 12 | Multi-instance: try-advisory-lock skip → exit 0 → serve trước khi migrate xong → mass 500 | Medium | Accept | Phase 3 |
| 13 | Migration nửa chừng (commit per-migration) + không restart policy/runbook | Medium | Accept | Phase 3, 5 |
| 14 | E2E cold-start không gate được trong CI (ci.yml không có Postgres/Docker) | Medium | Accept | Phase 5 |
| 15 | SDK runtime dep không pin (openapi-fetch) + snapshot test thiếu service devDep | Medium | Accept | Phase 4 |
| — | "Baseline V4 phase 1-5 chưa commit" | (n/a) | **Reject** | Stale — đã commit b278132/318533a/72b5bfd (verified git log) |

**Decision khác đề xuất reviewer (user override):** F3 reviewer nêu 3 lựa chọn (wire JWT / gỡ
endpoint / để dead-code + filter SDK); **user chọn wire JWT plane** — tăng scope phase 1 nhưng
giữ thiết kế D1 2-plane nguyên vẹn. Đã propagate, không tự đảo ngược.

### Whole-Plan Consistency Sweep
- **Table count:** reconcile 5/12 → **13** ở plan.md gap#4, phase 3 (doctor + danh sách đầy đủ
  gồm reconciliation_runs), phase 5 (installation.md fix + docs). Zero còn "12 tables" / "5 tables".
- **Checkout DTO:** reconcile `{amountMicros,currency}` → `{amountVnd}` (SePay) ở phase 4
  (Architecture + Success) và phase 5 (e2e step). Zero còn `amountMicros/currency` cho checkout.
- **Migrate dispatch:** phase 3 bỏ execSync nội suy (F9) + option A→B init-container (F1/F2/F12);
  phase 1 không còn nhắc compose command chuỗi. Nhất quán.
- **JWT plane:** phase 1 wire (F3) + plan gap#1 + open Q3 + phase 4 (mint reachable cho SDK note
  F11 filter). Nhất quán.
- **Lockfile:** phase 1 + phase 2 đều có step regenerate (F7); phase 3 build dựa lockfile fresh.
- **Mint contract:** phase 1 CLI enforce cap (F10) khớp HTTP invariant (router.ts:302); phase 4
  SDK filter mint (F11). Nhất quán plane-separation.
- **Zero unresolved contradictions.**

## Validation Log

### Session 1 — 2026-06-01
**Verification Pass:** SKIPPED — `## Red Team Review` đã có evidence `file:line` đầy đủ, không còn
`[UNVERIFIED]`. 4 câu hỏi decision-point còn mở (red-team chưa chốt).

| # | Question | Decision | Implication |
|---|----------|----------|-------------|
| 1 | [F3] Mount jwt ở đâu | **Mount cả api_key + jwt trên `/v1/*`** | Phase 1: 2 middleware coexist, mỗi cái pass-through nếu token không khớp dạng; jwt dùng được cho route admin tương lai. **Tăng yêu cầu test coexistence** (api_key→mint 403, jwt→mint OK, api_key→checkout OK) |
| 2 | [F15] SDK generator | **`openapi-typescript` types-only + wrapper tay** | Phase 4: KHÔNG runtime dep (an toàn supply-chain payment SDK); wrapper transport ~50 dòng. Bỏ nhánh `openapi-fetch` runtime |
| 3 | [F9] migrate dispatch | **Bỏ hẳn `migrate` sub-command trong main.ts, CLI-only** (Claude quyết theo ủy quyền) | Phase 3: xóa block `migrate`/`doctor` execSync trong `main.ts:121-135` (loại sạch injection); compose init-container gọi `node cli/dist/bin/paykit.js migrate up`. main.ts chỉ còn `serve`. KISS |
| 4 | [F10] Attribution `created_by` | **Thêm ngay + migration 013** | ⚠️ Phá claim "no new migration". Phase 1: migration 013 ALTER `api_keys` ADD `created_by`; CLI/HTTP mint ghi actor. Mirror `migrations/` + `cli/migrations/` + 2 manifest. **13 bảng KHÔNG đổi** (013 = thêm cột, không thêm bảng) |

**Decision Claude tự quyết (F9, user ủy quyền):** bỏ main.ts migrate — guard theo review-audit rule:
loại bỏ attack surface (injection) + xóa code thừa, không đảo ngược quyết định user nào.

### Whole-Plan Consistency Sweep (post-validation)
- **F3 #1:** phase 1 — đổi "wire jwtAuthMiddleware" thành "mount cả 2 trên `/v1/*` + pass-through";
  bổ sung test coexistence. plan gap#1 + open Q3 nhất quán.
- **F15 #2:** phase 4 — chốt types-only + wrapper; bỏ nhánh openapi-fetch runtime; Success +
  Risk cập nhật (không còn "runtime dep pin").
- **F9 #3:** phase 3 — đổi "sửa execSync" thành "xóa main.ts migrate/doctor sub-command";
  Related Files + Risk cập nhật. main.ts chỉ serve.
- **F10 #4:** phase 1 — thêm migration 013 (`api_keys.created_by`); plan Dependencies đổi
  "no new migration" → "migration 013". **13-table count giữ nguyên** (ALTER cột, không thêm
  bảng) → phase 3 doctor "13" KHÔNG đổi. mint (CLI + HTTP) ghi `created_by`.
- **Zero unresolved contradictions** sau propagate.
