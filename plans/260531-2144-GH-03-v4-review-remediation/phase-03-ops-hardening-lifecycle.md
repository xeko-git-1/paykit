---
phase: 3
title: "Ops hardening + lifecycle"
status: completed
priority: P2
effort: "4-5h"
dependencies: [2]
---

# Phase 3: Ops hardening + lifecycle

> **`blockedBy [2]`:** Phase 2 + Phase 3 cùng sửa `packages/service/src/main.ts` → tuần tự tránh conflict.
> User chốt: merchant suspension **DEFER V4.x** (Q3) → phase này chỉ DOCUMENT gap, KHÔNG enforce.

## Overview

Đóng các footgun vận hành reviewer phát hiện trên service shell: config fail-fast cho creds
từng phần, lifecycle (graceful shutdown, pool error), `/readyz` rò connection, Docker/migrate
correctness. Không đụng business logic.

## Requirements

**Functional**
- **Partial creds fail-fast (#2):** nếu phát hiện ≥1 env var của provider nhưng thiếu var bắt buộc
  (vd `STRIPE_SECRET_KEY` có, `STRIPE_WEBHOOK_SECRET` vắng) → throw rõ ràng lúc boot, KHÔNG drop lặng.
- **Zero-provider warn (#3):** boot với 0 adapter → log warn "no payment providers configured".
- **migrate/doctor đúng trong container (#6):** thay bare `paykit` bằng `pnpm exec paykit` hoặc
  đường dẫn tuyệt đối `node packages/cli/dist/bin/paykit.js`; truyền `DATABASE_URL` qua **env**,
  KHÔNG qua `--db-url` argv (lộ password qua `ps`/proc).
- **`.dockerignore` đúng chỗ (#7):** chuyển lên **repo root** (docker đọc tại context root =
  `docker-compose.yml:24` `context: .`); exclude `node_modules`, `.git`, `plans`, `.claude`, `.env`.
- **`/readyz` bounded (#8):** query có `statement_timeout` / client huỷ được (không rò pg connection
  khi timer 2s thắng); `clearTimeout` + `.unref()` ở happy path.
- **Graceful shutdown (#9):** bắt SIGTERM → drain in-flight + `pool.end()`; thêm `pool.on('error')`
  để idle client error không crash process. `serve()` bắt lỗi bind (EADDRINUSE).
- **Admin secret timing-safe (Minor):** `main.ts:98` dùng `crypto.timingSafeEqual` thay `!==`.

**Document-only (DEFER — KHÔNG code)**
- **Merchant suspension (Q3):** `merchants.status` hiện write-only; `resolveMerchantTenant`
  (`main.ts:73`) không đọc status → suspend không cắt API access. **Document gap rõ** trong
  README service + code comment ("status enforcement deferred to V4.x"). KHÔNG enforce phase này.
- **`/v1/admin/*` coupling (#5):** admin route bị `apiKeyAuthMiddleware` `/v1/*` chặn trước adminGuard
  → admin buộc kèm merchant key. Document hiện trạng; quyết định tách admin plane defer (note Open Q).

## Related Code Files

- **Modify:** `packages/service/src/config.ts` (partial-creds fail-fast)
- **Modify:** `packages/service/src/adapters-from-env.ts` (zero-provider warn)
- **Modify:** `packages/service/src/main.ts` (SIGTERM/shutdown, pool.on error, migrate/doctor exec, admin secret timing-safe, serve bind error)
- **Modify:** `packages/service/src/health.ts` (readyz timeout/cleanup)
- **Create:** `.dockerignore` (repo root); **Delete:** `packages/service/.dockerignore` (sai chỗ)
- **Verify:** `packages/service/Dockerfile` runtime stage có copy migrations CLI tìm được (Open Q3)
- **Modify:** README service (document suspension defer, mode non-isolated, admin coupling)
- **Create (TEST FIRST):** `packages/service/__tests__/config-partial-creds.test.ts`, mở rộng health test

## Implementation Steps (TDD)

1. **RED:**
   - `config-partial-creds.test.ts`: STRIPE_SECRET_KEY có + WEBHOOK_SECRET vắng → throw; đủ → OK; 0 provider → boot + warn.
   - health: readyz khi DB "treo" (mock chậm) → trả 503 trong ~2s, KHÔNG hang; happy path clear timer.
   Chạy → FAIL.
2. **GREEN:** thực thi Requirements (functional). Document-only items: cập nhật README + comment.
3. **VERIFY:** `pnpm --filter @xeko-git-1/paykit-service build && pnpm vitest run packages/service` → PASS.
   `docker build` (nếu daemon có) → image build; `docker compose up` → migrate chạy được trong container
   (Open Q3 resolved). Nếu daemon vắng → xác nhận Dockerfile + compose syntactically sound + nêu rõ skip.

## Success Criteria

- [x] Partial creds → fail-fast rõ ràng; 0 provider → warn (không im lặng)
- [x] `/readyz` không rò pg connection + không hang khi DB chậm; `/healthz` vẫn no-DB
- [x] SIGTERM drain + pool.end + pool.on('error'); serve bắt bind error
- [x] `.dockerignore` ở repo root; migrate/doctor chạy được trong container (bin trên PATH + DB url qua env)
- [x] Admin secret compare timing-safe
- [x] Suspension gap + admin coupling + mode non-isolated DOCUMENTED (không enforce — đúng Q3)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Partial-creds fail-fast quá nhạy chặn deploy hợp lệ | Med | Med | Chỉ throw khi có ≥1 var provider mà thiếu var bắt buộc; 0 var = OK (provider tắt) |
| Graceful shutdown drain treo nếu request hang | Low | Med | Timeout drain (vd 10s) rồi force exit |
| migrate trong container vẫn không tìm thấy migrations (Open Q3) | Med | High | Verify runtime stage copy đúng dir; test `docker compose up` migrate thật |
| readyz đổi sang client riêng phức tạp hóa | Low | Low | Ưu tiên `statement_timeout` trên query đơn giản hơn tạo client mới |
