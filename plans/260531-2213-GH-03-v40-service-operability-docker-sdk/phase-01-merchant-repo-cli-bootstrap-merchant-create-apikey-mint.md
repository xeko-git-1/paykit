---
phase: 1
title: "Auth end-to-end: merchant repo, CLI bootstrap, wire JWT plane in service"
status: completed
priority: P1
effort: "6h"
dependencies: []
---

# Phase 1: Auth end-to-end — merchant repo, CLI bootstrap, wire JWT plane in service

> **Red-team applied (2026-06-01):** F3 (Critical) — JWT plane chưa được wire vào service
> (`main.ts:78` chỉ mount `apiKeyAuthMiddleware`; `jwtSecretLoader` build rồi bỏ ở
> `main.ts:47`). Mint `/v1/api-keys` đòi `requirePlane("jwt")` (`router.ts:285`) → endpoint
> **chết vĩnh viễn** trong service mode, không chỉ cold-start. **Quyết định user: wire JWT
> plane.** Phase này gộp: (a) merchant repo, (b) CLI bootstrap key đầu tiên, (c) wire
> jwtAuthMiddleware + đường phát JWT. F5 (drizzle client), F8 (plaintext→logs), F10 (cap +
> attribution) áp ở đây.

## Overview

Làm cho authentication chạy thật từ cold-start tới HTTP mint. Hai đường mint với trust boundary
rõ: **CLI** (operator, cần DB-URL = tier-0 secret) bootstrap key đầu tiên; **HTTP `/v1/api-keys`**
(JWT plane) cho admin/dashboard về sau. Phase 5 cũ đã viết mint endpoint nhưng JWT plane chưa
mount → phải wire mới dùng được.

## Requirements

**Functional**
- `merchant.repo.ts`: `insert(db,{name})`, `findById`, `list` — Drizzle handle (`DbOrTx`).
- **CLI (operator bootstrap, thao tác DB trực tiếp, KHÔNG cần service up):**
  - `paykit merchant create --name <name> [--db-url]` → in `merchant_id`.
  - `paykit apikey mint --merchant <id> --scopes <csv> [--mode] [--db-url]`:
    validate merchant tồn tại + scopes ⊆ `SCOPES` (`auth/scope.ts:13`) → `mintApiKey` →
    `apiKeyRepo.insert` → in plaintext **1 lần** + cảnh báo. **F10:** enforce cùng per-merchant
    cap (`apiKeyRepo.countActiveByMerchant`, `router.ts:302`) như HTTP, KHÔNG bypass.
  - **F8:** in cảnh báo "key sẽ hiện ở stdout/CI/docker logs — chạy interactive, không qua
    `docker compose exec` trong môi trường log tập trung". Doc khuyến nghị rotate ngay nếu lỡ log.
- **Wire JWT plane (F3):**
  - `main.ts`: `app.use("/v1/*", jwtAuthMiddleware(...))` hoặc mount selective sao cho api_key
    plane + jwt plane cùng giải quyết auth (api_key cho s2s, jwt cho admin/dashboard); plane do
    middleware set `paykitAuth.plane`. Dùng `jwtSecretLoader` đã build (`main.ts:162`) — hiện bị
    bỏ. KHÔNG để mint thành dead code.
  - **Đường phát JWT đầu tiên:** `paykit jwt mint --merchant <id> --ttl <sec> [--db-url]` ký
    short-lived admin JWT bằng secret từ `runtime_config` (mirror `createJwtSecretLoader`).
    Đây là cầu để admin lấy JWT gọi `/v1/api-keys` mà chưa cần dashboard login (defer V4.4).

**Non-functional**
- Plaintext key + JWT chỉ stdout, không log file.
- CLI import `mintApiKey`/`apiKeyRepo`/`merchantRepo`/`SCOPES` từ `@vibecc/paykit-server` barrel
  (`server/src/index.ts` — đã export, verified).
- **F5:** CLI phải tạo **Drizzle** client (`drizzle(pgClient)`) cho repo, KHÔNG truyền raw
  `pg.Client`. Repo gọi `db.insert().values().returning()` (`api-key.repo.ts:23`) đòi Drizzle.
  `withClient` hiện trả `pg.Client` (`paykit.ts:36-48`) — thêm `withDb` bọc Drizzle, giữ
  `withClient` cho migrate (raw).

## Architecture

```
CLI (operator, DB-URL):
  paykit merchant create --name → withDb(drizzle) → merchantRepo.insert → stdout merchant_id
  paykit apikey mint --merchant --scopes → withDb → validate scopes⊆SCOPES + merchant exists
       → countActiveByMerchant < CAP (F10) → mintApiKey → apiKeyRepo.insert → stdout pk_ (once+warn)
  paykit jwt mint --merchant --ttl → load secret(runtime_config) → sign admin JWT → stdout (once)

Service (main.ts) — wire BOTH planes on /v1:
  app.use("/v1/*", apiKeyAuthMiddleware(...))   ← s2s (existing)
  app.use("/v1/*", jwtAuthMiddleware({ secretLoader: jwtSecretLoader, ... }))  ← F3 NEW (admin)
       middleware sets paykitAuth.plane = "api_key" | "jwt"
  /v1/api-keys [requirePlane("jwt")] now reachable with admin JWT (scope-subset + cap enforced)
```

> **Plane-coexistence note:** verify thứ tự middleware — một request mang api_key Bearer KHÔNG
> được jwt middleware reject (và ngược lại). Mẫu: mỗi middleware chỉ set plane khi token khớp
> dạng của nó, pass tiếp nếu không; cuối cùng route-level `requirePlane` enforce. Lock hành vi
> bằng test (api_key gọi mint → 401/403 plane; jwt gọi mint → OK).

## Related Code Files

<!-- Updated: Validation Session 1 — F3 mount cả 2 plane trên /v1/*; F9 main.ts CLI-only; F10 migration 013 created_by -->

- **Create:** `migrations/013_api_keys_created_by.up.sql` + `.down.sql` (F10: ALTER `paykit.api_keys`
  ADD COLUMN `created_by text`); mirror `packages/cli/migrations/013_*`; cập nhật cả 2 manifest
  (`migrations/manifest.json` + `packages/cli/migrations/manifest.json`). **Down = DROP COLUMN**
  (an toàn — cột mới, không phá key đang dùng).
- **Modify:** `packages/server/src/db/schema/api-keys.ts` — thêm field `createdBy`
- **Create:** `packages/server/src/db/repos/merchant.repo.ts`
- **Modify:** `packages/server/src/index.ts` — export `* as merchantRepo`
- **Modify:** `packages/cli/src/bin/paykit.ts` — 3 command (`merchant create`, `apikey mint`, `jwt mint`) + `withDb` Drizzle helper
- **Create:** `packages/cli/src/lib/bootstrap.ts` — create/mint/jwt logic (testable, cap-enforced, ghi `created_by`)
- **Modify:** `packages/cli/package.json` — dep `@vibecc/paykit-server`, `drizzle-orm`; **F7: regenerate + commit `pnpm-lock.yaml`**
- **Modify:** `packages/service/src/main.ts` — **F3:** mount CẢ `apiKeyAuthMiddleware` + `jwtAuthMiddleware`
  trên `/v1/*` (pass-through nếu token không khớp dạng); **F9:** XÓA `migrate`/`doctor` sub-command
  (chỉ giữ `serve`) — loại execSync injection
- **Modify:** `packages/server/src/v1/router.ts` (hoặc mint helper) — ghi `created_by` = actor khi mint
- **Create (TEST FIRST):** `packages/cli/__tests__/bootstrap-merchant-apikey-jwt.test.ts`
- **Create (TEST FIRST):** `packages/server/__tests__/merchant-repo.test.ts`
- **Modify (TEST):** `packages/server/__tests__/v4-migrations-shape.test.ts` — thêm shape 013
- **Modify (TEST):** `packages/service/__tests__/` — plane-coexistence: api_key vs jwt on mint

## Implementation Steps (TDD)

1. **RED:**
   - `v4-migrations-shape.test.ts`: migration 013 thêm cột `api_keys.created_by` (shape test);
     down drop cột.
   - `merchant-repo.test.ts`: insert→findById round-trip; list.
   - `bootstrap-*.test.ts`: mint scope hợp lệ → record đúng + **`created_by` được set (F10)**;
     scope lạ → reject; merchant vắng → reject; **cap đạt → reject (F10)**; plaintext có prefix
     `pk_`; `jwt mint` → token verify được bằng secret runtime_config.
   - Service plane test: với jwt plane → `/v1/api-keys` 2xx; với api_key plane → 401/403; api_key
     vẫn gọi được `/v1/checkouts` (không bị jwt middleware chặn).
   Chạy → FAIL.
2. **GREEN:**
   - Migration 013 (ALTER api_keys ADD created_by) + mirror cli/migrations + 2 manifest; thêm
     field `createdBy` vào schema.
   - `merchant.repo.ts` (mirror api-key.repo, Drizzle); export barrel.
   - `withDb` (drizzle wrapper) trong CLI; `bootstrap.ts` (create/mint/jwt, cap-check, ghi created_by).
   - Wire 3 CLI command.
   - **F3:** mount cả `apiKeyAuthMiddleware` + `jwtAuthMiddleware` trên `/v1/*` (dùng
     `jwtSecretLoader` đang bị bỏ); đảm bảo plane-coexistence (pass-through theo dạng token).
   - **F9:** XÓA `migrate`/`doctor` sub-command khỏi `main.ts` (chỉ giữ `serve`).
   - Regenerate lockfile.
3. **VERIFY:** `pnpm install && pnpm --filter @vibecc/paykit-cli --filter @vibecc/paykit-server --filter @vibecc/paykit-service build && pnpm vitest run packages/cli packages/server packages/service` → PASS.

## Success Criteria

- [x] **F10:** migration 013 thêm `api_keys.created_by`; up/down shape test xanh; **13-table count KHÔNG đổi** (ALTER cột)
- [x] `paykit merchant create` → merchant_id; `apikey mint` → `pk_` (once + warn) + ghi `created_by`; `jwt mint` → admin JWT
- [x] CLI mint enforce per-merchant cap (F10), KHÔNG bypass HTTP invariant
- [x] Scope lạ / merchant vắng / cap đạt → reject rõ ràng
- [x] **F3:** mount cả 2 plane trên `/v1/*`; `/v1/api-keys` reachable bằng admin JWT (scope-subset + cap)
- [x] **F3 coexistence:** api_key plane gọi mint → 403; api_key vẫn dùng `/v1/checkouts`; jwt mint OK
- [x] **F5:** CLI dùng Drizzle handle (không crash raw pg.Client)
- [x] **F9:** `main.ts` chỉ còn `serve` command (không execSync migrate/doctor)
- [x] **F7:** lockfile regenerated + committed; `pnpm install` xanh
- [x] Embedded mode KHÔNG đổi

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F3: jwt + api_key middleware xung đột trên `/v1/*` → reject nhầm plane | Med | High | Mỗi middleware set plane chỉ khi token khớp dạng, pass-through nếu không; test coexistence cả 2 chiều |
| F5: raw pg.Client cho repo Drizzle → crash command đầu | High | High | `withDb` drizzle wrapper; test round-trip thật |
| F8: plaintext key/JWT vào docker/CI logs | Med | High | Stdout-only + cảnh báo in-band; doc "interactive, không exec trong log tập trung"; rotate nếu lỡ |
| F10: CLI mint bỏ qua cap → vượt invariant HTTP | Med | Med | CLI gọi `countActiveByMerchant` trước mint (cùng cap = 10) |
| F10: migration 013 trên api_keys đang có dữ liệu | Low | Med | ADD COLUMN nullable (không default phá) — an toàn; down = DROP COLUMN |
| CLI `--merchant` mint cross-tenant (operator) | Med | Med | Trust boundary: DB-URL = tier-0 operator secret (document); **`created_by` (013) cho audit ai mint** |
| F7: frozen-lockfile fail khi build docker | High | High | Regenerate + commit lockfile trong phase này (gating cho phase 3 build) |
