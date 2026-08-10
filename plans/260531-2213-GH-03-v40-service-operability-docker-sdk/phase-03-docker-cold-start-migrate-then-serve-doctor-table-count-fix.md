---
phase: 3
title: "Docker cold-start (migrate then serve) + doctor table-count fix"
status: completed
priority: P1
effort: "5h"
dependencies: [1]
---

# Phase 3: Docker cold-start (migrate then serve) + doctor table-count fix

> **Red-team applied (2026-06-01):** F1 (Crit) ENTRYPOINT exec-form không bị CMD override →
> compose `command` thành argv của main.js → "Unknown command". F2 (Crit) `paykit` bin không
> trong runtime PATH → `execSync("paykit migrate")` chết. F9 (High) `execSync` nội suy
> `DATABASE_URL` chưa escape → shell injection. F6 (High) **13 bảng** không phải 12 (thiếu
> `reconciliation_runs`). F12 (Med) try-advisory-lock skip → serve trước khi migrate xong khi
> multi-instance. F13 (Med) migration nửa chừng + không restart policy.

## Overview

DB tươi qua docker-compose: `command:["serve"]` chạy serve trên DB chưa migrate → mọi query
fail. Sửa cold-start chạy migrate trước serve **không qua `paykit` bin / không qua execSync
nội suy**, fix doctor hardcode "5 tables" → **13** (đếm động), verify `docker compose build &&
up` chạy thật end-to-end.

## Requirements

**Functional**
- Cold-start: migrate up (13 migration) → serve. `/healthz` 200, `/readyz` 200.
- doctor: số bảng kỳ vọng **đếm động = 13** (không hardcode); thiếu → liệt kê đúng.
- **F1/F2:** không phụ thuộc `paykit` bin trong PATH, không dùng exec-form ENTRYPOINT nuốt CMD.

**Non-functional**
- **F9:** bỏ `execSync(\`paykit migrate ${cmd} --db-url "${dbUrl}"\`)` (`main.ts:133-135`) — nội
  suy DSN chưa escape. Thay bằng gọi migrate-lib trực tiếp trong process (import `migrateUp` từ
  `@xeko-git-1/paykit-cli`) HOẶC `spawnSync("node",[cliPath,"migrate","up"],{env})` (argv array,
  DSN qua env không qua shell string).
- **F12:** migrate up phải **chặn serve cho tới khi schema ở HEAD**. try-lock skip (exit 0) hiện
  cho serve chạy sớm khi instance khác đang migrate. Dùng blocking `pg_advisory_lock` HOẶC
  HEAD-check (`migrate status` = no pending) trước serve; nếu chưa HEAD → chờ/exit non-zero.
- **F13:** migrate fail giữa chừng (commit per-migration, `migration-runner.ts:82-99`) → có
  runbook recovery; `restart: on-failure` CHỈ cho migrate-init service, KHÔNG cho serve (tránh
  che crash-loop).
- Không auto-migrate trong `serve` command (giữ separation).

## Architecture

```
Dockerfile fix (F1/F2):
  - ENTRYPOINT đổi shell-form HOẶC clear entrypoint ở compose: `entrypoint: []`
  - Đảm bảo gọi được cli: `node packages/cli/dist/bin/paykit.js` (path tuyệt đối trong image)
    thay vì dựa `paykit` trên PATH

docker-compose (option B — init container, F12/F13):
  migrate:
    entrypoint: []
    command: ["node","packages/cli/dist/bin/paykit.js","migrate","up"]
    environment: { DATABASE_URL }
    depends_on: { postgres: { condition: service_healthy } }
    restart: on-failure        # F13: chỉ migrate-init
  serve:
    command: ["serve"]         # ENTRYPOINT giữ → node main.js serve
    depends_on: { migrate: { condition: service_completed_successfully } }   # F12: serve sau migrate HEAD

main.ts (F9 — Validation S1): `migrate`/`doctor` sub-command XÓA khỏi main.ts (làm ở phase 1),
  loại sạch execSync nội suy DSN. main.ts chỉ còn `serve`. Migrate chạy qua compose init-container
  gọi CLI bin trực tiếp (dưới đây).

doctor.ts (F6): EXPECTED = 13 bảng (đếm động từ migration SQL / manifest), bỏ literal "5".
```

> **Quyết định:** chọn **option B (init-container)** thay option A. Lý do red-team F1+F12: chuỗi
> `sh -c "migrate && serve"` đụng ENTRYPOINT exec-form + try-lock race. Init-container +
> `service_completed_successfully` giải cả hai sạch hơn, multi-instance-safe thật. **F9
> (Validation S1):** main.ts không còn migrate sub-command → compose gọi thẳng CLI bin, không
> qua execSync.

## Related Code Files

<!-- Updated: Validation Session 1 — F9 main.ts migrate removed (phase 1); compose calls CLI bin direct -->

- **Modify:** `docker-compose.yml` — tách `migrate` init service + `serve`; `depends_on
  completed_successfully` (F1/F12/F13)
- **Modify:** `packages/service/Dockerfile` — đảm bảo cli dist + bin gọi được qua node path; xét
  ENTRYPOINT (F2)
- **Note:** `packages/service/src/main.ts` migrate/doctor sub-command đã XÓA ở **phase 1** (F9) —
  phase 3 KHÔNG sửa main.ts; chỉ dựa compose init-container gọi `node packages/cli/dist/bin/paykit.js`
- **Modify:** `packages/cli/src/lib/doctor.ts` — **F6:** bỏ hardcode "5"; expected = 13 động
  (line ~71-76)
- **Create:** runbook recovery note trong `docs/` (F13) — để phase 5; phase này chỉ verify

## Implementation Steps

1. **Fix doctor (F6):**
   - Expected tables = 13: api_keys, balance_projections, customers, idempotency_records,
     ledger_entries, merchants, payment_transactions, pending_refunds, **reconciliation_runs**,
     runtime_config, subscription_events, subscriptions, webhook_events (verified từ
     `migrations/*.up.sql`). Derive động (đọc manifest hoặc set hằng đầy đủ); message theo
     `EXPECTED.size`.
2. **Migrate dispatch (F9 — Validation S1):**
   - main.ts migrate/doctor sub-command đã XÓA ở phase 1 (CLI-only) → KHÔNG còn execSync nội suy
     DSN. Phase 3 chỉ verify compose init-container gọi `node packages/cli/dist/bin/paykit.js
     migrate up` (DSN qua env, không qua shell string).
3. **Compose option B (F1/F2/F12/F13):**
   - Tách service `migrate` (init) + `serve`; `entrypoint: []` cho migrate gọi node cli path
     trực tiếp; serve `depends_on migrate: completed_successfully`; `restart: on-failure` chỉ migrate.
4. **Verify docker build + cold-start THẬT:**
   - `docker compose build` (chứa 6 adapter — phase 2; lockfile fresh — F7).
   - `docker compose up` volume sạch → migrate init applied 13 → serve listening → `/healthz`
     200, `/readyz` 200.
   - `docker compose run --rm migrate` lại → idempotent (nothing to apply).
   - Bootstrap (phase 1): tạo merchant + mint key qua CLI trong container → OK.

## Success Criteria

- [x] **F1/F2:** `docker compose up` cold DB: migrate init chạy (không "Unknown command", không
      "paykit: not found") → serve lên không query-fail
- [x] `/healthz` 200 + `/readyz` 200 sau cold-start
- [x] **F6:** doctor báo đúng **13** bảng; thiếu reconciliation_runs → bắt được
- [x] **F9:** main.ts không còn migrate sub-command (xóa ở phase 1) → không execSync nội suy DSN; compose gọi CLI bin trực tiếp
- [x] **F12:** serve chỉ chạy sau khi migrate ở HEAD (init completed_successfully)
- [x] **F13:** migrate-init có `restart: on-failure`; serve KHÔNG; runbook recovery ghi (phase 5)
- [x] `docker compose build` thành công với 6 adapter

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F1: CMD không override exec-form ENTRYPOINT → "Unknown command" | High | **Critical** | Option B init-container + `entrypoint: []`; test compose up thật |
| F2: `paykit` bin off PATH → migrate chết | High | **Critical** | Gọi `node packages/cli/dist/bin/paykit.js` path trực tiếp; không dựa PATH |
| F9: execSync nội suy DSN → shell injection lúc boot | Med | High | XÓA main.ts migrate sub-command (phase 1, CLI-only) → attack surface biến mất; compose gọi CLI bin argv trực tiếp |
| F12: multi-instance serve trước migrate → mass 500 | Med | High | init-container completed_successfully; (hoặc blocking lock + HEAD-check) |
| F6: doctor list lệch tên thật → false negative | Med | Med | Đối chiếu 13 bảng với migration up; test |
| F13: migrate nửa chừng, không recovery | Low | Med | restart on-failure (migrate only) + runbook; commit per-migration nên resume được |
| docker build chậm/fail (pnpm workspace Alpine) | Med | Med | Build thật phase này; fix Dockerfile nếu vỡ |
