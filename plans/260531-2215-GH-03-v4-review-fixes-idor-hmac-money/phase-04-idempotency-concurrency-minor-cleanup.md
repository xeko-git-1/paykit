---
phase: 4
title: "Idempotency concurrency + minor cleanup"
status: pending
priority: P2
effort: "4h"
dependencies: [1]
---

# Phase 4: Idempotency concurrency + minor cleanup

## Overview
Khắc phục **I2** (Important): idempotency middleware là SELECT-miss → handler → record-after, không lock/insert-first, nên hai request trùng key đồng thời cùng chạy handler mutating. Cộng dồn minor: **M1** base62 encoder lỗi, **M2** thiếu validate 2 chữ số USD, **M3** dead-code handler, **M5** subscription tenant-routes chưa migrate, **M7** document negative-balance. **M6 đã đóng** (giữ index — xem ghi chú cuối).

> **dependencies: [1]** — Phase 4 thêm migration `014` (sau `013` của Phase 1) và cùng sửa `v4-migrations-shape.test.ts` + `checkout-router.ts`. PHẢI chạy SAU Phase 1, KHÔNG song song (red-team finding E).

## Requirements
- Functional: hai request đồng thời cùng `(tenant_id, key)` chỉ một chạy handler; cái còn lại nhận replay (nếu xong) hoặc 409 in-flight; handler crash KHÔNG khoá vĩnh viễn key (TTL-reclaim).
- Non-functional: giữ ngữ nghĩa replay/body-mismatch (422)/missing-key (400) hiện có.

## Architecture
**I2 — `idempotency-middleware.ts:82-122` + `idempotency.repo.ts` + schema `idempotency-records.ts`:**
Red-team finding B: insert-first naïve sẽ FAIL vì `responseStatus` là `NOT NULL` không default (`idempotency-records.ts:19`), và placeholder không có cleanup → handler crash = poison-record khoá key 24h.
- **Hướng đã chốt: migration + state column.** Migration `014_idempotency_in_flight_state`:
  - Thêm cột `state TEXT NOT NULL DEFAULT 'done'` CHECK `(state IN ('in_flight','done'))`.
  - `response_status` → nullable (in_flight chưa có response).
  - (Tận dụng `expires_at` sẵn có cho TTL-reclaim hàng in_flight — dùng TTL ngắn riêng, vd 120s, khi insert in_flight.)
- Repo: thêm `insertInFlight(tx, {...})` (state='in_flight', expires_at=now+120s, response_status=null) + `finalizeIdempotency(...)` (UPDATE state='done', response_status, response_body, expires_at=now+24h). On-conflict đọc `state`:
  - `done` & chưa hết hạn → replay response.
  - `in_flight` & chưa hết hạn → 409 `IDEMPOTENCY_IN_FLIGHT`.
  - bất kỳ row nào `expires_at < now` → coi là miss, UPDATE chiếm lại (reclaim) → tránh poison.
- Middleware: insert-first trong tx; crash/non-2xx → để TTL ngắn tự reclaim (không cần DELETE thủ công, nhưng có thể thêm best-effort markFailed).

**Minor:**
- **M1** `auth/api-key.ts:22-30` — `toBase62` dùng `Math.floor(byte/4)%62` (không injective: byte 0 và 248 → cùng `"00"`). Fix encoder injective; đảm bảo entropy ≥256-bit từ `randomBytes(32)`. (kit chưa publish, chưa có key production — xác nhận DB rỗng key trước khi đổi.)
- **M2** `checkout-router.ts:41` schema — `amountUsd: z.number()` → `.multipleOf(0.01)` (chặn `19.999`). **Lưu ý:** file này Phase 1 cũng sửa (call site ~122) → Phase 4 chạy sau Phase 1.
- **M3** dead-code: `webhooks/stripe-handler.ts` + `sepay-handler.ts` không mount (chỉ generic router `create-paykit.ts:166`); `stripe-handler.ts` over-refund cumulative. **Finding M:** `index.ts` KHÔNG export 2 builder này → chỉ cần grep xác nhận không consumer (e2e/docs/tests) rồi **xóa 2 file**; KHÔNG có bước "bỏ export trong index.ts".
- **M5** `subscriptions/tenant-routes.ts` — **Finding L:** các dòng 67/81/95/119/139 gọi helper `resolveTenant(c, tenantResolver)` (KHÔNG phải `tenantResolver(c.req.raw)` trực tiếp — chỗ đó chỉ ở `:168`). Blast radius gồm helper `resolveTenant` + dep injection + `buildIdempotencyMiddleware({...tenantResolver})` (`:63`). M5 + I2 CÙNG đụng idempotency-middleware → làm I2 trước, M5 sau (hoặc gộp). Migrate sang `getAuthTenant(c)`; scoping đã đúng (`row.tenantId !== tenant.tenantId`).
- **M7** chỉ document: comment ở `balance.repo.ts applyDelta` rằng balance âm hợp lệ (chargeback/refund sau rút) — không guard (user xác nhận).

## Related Code Files
- Modify: `packages/server/src/routes/subscriptions/idempotency-middleware.ts`, `packages/server/src/db/repos/idempotency.repo.ts`, `packages/server/src/db/schema/idempotency-records.ts`
- Create: `migrations/014_idempotency_in_flight_state.up.sql` + `.down.sql` + cli mirror + 2 manifest.json
- Modify: `packages/server/__tests__/v4-migrations-shape.test.ts` — count 13→14 (sau Phase 1) + shape 014
- Modify: `packages/server/src/auth/api-key.ts` (toBase62) + test `api-key-auth-primitives.test.ts`
- Modify: `packages/server/src/routes/checkout/checkout-router.ts` (schema, sau Phase 1)
- Modify: `packages/server/src/routes/subscriptions/tenant-routes.ts` + helper `resolveTenant`
- Modify: `packages/server/src/db/repos/balance.repo.ts` (comment only)
- Delete: `packages/server/src/routes/webhooks/stripe-handler.ts`, `sepay-handler.ts` (sau grep xác nhận unmount; KHÔNG có export trong index.ts để gỡ)

## Implementation Steps
1. Migration `014`: state column + nullable response_status + CHECK; cập nhật 2 manifest + test shape (count 14).
2. I2 repo: `insertInFlight` + `finalizeIdempotency` + reclaim theo `expires_at`. Refactor middleware insert-first; on-conflict phân nhánh theo state; 409 `IDEMPOTENCY_IN_FLIGHT` mới (cập nhật doc/test).
3. M1: viết lại `toBase62` injective + test phân phối/độ dài + prefix `pk_live_`/`pk_test_` đúng.
4. M2: `.multipleOf(0.01)` cho `amountUsd`.
5. M3: `grep -rn "stripe-handler\|sepay-handler\|buildStripeWebhookRoute\|buildSepayWebhookRoute" e2e packages docs`; nếu sạch → xóa 2 file. Xác nhận `webhook-router.ts` không import.
6. M5: migrate tenant-routes + helper `resolveTenant` sang `getAuthTenant`; cập nhật `buildIdempotencyMiddleware` dep; test scoping vẫn chặn cross-tenant.
7. M7: comment invariant ở `applyDelta`.
8. Build + chạy test toàn server + adapter.

## Success Criteria
- [ ] Hai request đồng thời cùng key chỉ một chạy handler; handler crash KHÔNG khoá vĩnh viễn (TTL-reclaim) — test concurrency + crash
- [ ] Migration 014 lên/xuống sạch; `v4-migrations-shape.test.ts` count=14 xanh
- [ ] `toBase62` injective; key ≥256-bit entropy
- [ ] `amountUsd` >2 chữ số bị từ chối
- [ ] Dead-code handler đã xóa, build pass
- [ ] tenant-routes + idempotency-middleware dùng auth context; scoping test xanh
- [ ] `pnpm build` toàn workspace pass; toàn bộ test xanh

## Risk Assessment
- I2 thêm migration 014 + cột state → `pnpm test` migration-shape phải cập nhật cùng commit (finding C/B), nếu không đỏ.
- 409 `IDEMPOTENCY_IN_FLIGHT` là mã lỗi mới → cập nhật OpenAPI/doc + test; giữ nguyên 422/400 cũ.
- M5 blast radius lớn hơn 5 dòng (helper + dep + middleware) — không underestimate; M5+I2 cùng file idempotency-middleware → ordering nội bộ I2 trước.
- Xóa dead-code: bắt buộc grep e2e+docs trước; nghi ngờ thì deprecate thay vì xóa.
- M1 đổi encoder: xác nhận DB không có key thật trước khi đổi.

## Removed scope (red-team finding D, M6)
- **M6 (xóa index `key_hash`):** ĐÓNG. Index trùng UNIQUE vô hại; `v4-migrations-shape.test.ts:41-42` đang pin nó; sửa 012 in-place là no-op trên DB đã apply (schema drift). Không đáng rủi ro. Giữ nguyên index.
