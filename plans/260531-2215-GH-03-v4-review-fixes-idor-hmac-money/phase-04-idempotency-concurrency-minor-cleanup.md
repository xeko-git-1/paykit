---
phase: 4
title: "Idempotency concurrency + minor cleanup"
status: pending
priority: P2
effort: "3h"
dependencies: []
---

# Phase 4: Idempotency concurrency + minor cleanup

## Overview
Khắc phục **I2** (Important): idempotency middleware là SELECT-miss → handler → record-after, không lock/insert-first, nên hai request trùng key đồng thời cùng chạy handler mutating. Cộng dồn các minor: **M1** base62 encoder lỗi, **M2** thiếu validate 2 chữ số USD, **M3** dead-code handler lệch hành vi, **M5** subscription tenant-routes chưa migrate, **M6** index thừa, **M7** document invariant negative-balance.

## Requirements
- Functional: hai request đồng thời cùng `(tenant_id, key)` chỉ một chạy handler; cái còn lại nhận replay hoặc lỗi in-flight, không double-execute.
- Non-functional: giữ nguyên ngữ nghĩa replay/body-mismatch hiện có.

## Architecture
**I2 — `packages/server/src/routes/subscriptions/idempotency-middleware.ts:82-122` + `packages/server/src/db/repos/idempotency.repo.ts`:**
- Hiện `lookupIdempotency` chỉ SELECT (idempotency.repo.ts:41-59), record ghi sau handler (middleware 113-121).
- Fix: insert hàng placeholder `(tenant_id, key, provider, route_path, body_hash)` ngay lúc lookup trong tx; dựa vào PK/UNIQUE `(tenant_id, key)` — nếu unique-violation → request đang in-flight hoặc đã có → trả replay (nếu có response) hoặc 409 in-flight. Hoàn tất thì UPDATE placeholder bằng response thật.

**Minor:**
- **M1** `packages/server/src/auth/api-key.ts:22-30` — `toBase62` dùng `Math.floor(byte/4)%62` (sai, không injective: byte 0 và 248 → cùng `"00"`). Fix: encode đúng (vd `byte % 62` + `Math.floor(byte/62)` cho dải [0,255]→[0,4], hoặc encode cả buffer như base62 bigint). Đảm bảo entropy ≥ 256-bit từ `randomBytes(32)`.
- **M2** `packages/server/src/routes/checkout/checkout-router.ts:105` + schema (~41) — `amountUsd: z.number()` → `z.number().multipleOf(0.01)` để chặn `19.999`.
- **M3** dead-code: `packages/server/src/routes/webhooks/stripe-handler.ts` + `sepay-handler.ts` không được mount (chỉ generic router tại `create-paykit.ts:166`). `stripe-handler.ts:159` over-refund theo `amount_refunded` cumulative. Quyết định: **xóa** 2 handler dead + export builder của chúng trong `index.ts` (xác nhận không có consumer ngoài qua grep trước khi xóa).
- **M5** `packages/server/src/routes/subscriptions/tenant-routes.ts:67,81,95,119,139` còn `tenantResolver(c.req.raw)`. Migrate sang `getAuthTenant(c)` (giữ fallback resolver như checkout nếu cần embedded mode). Scoping đã đúng (`row.tenantId !== tenant.tenantId`), chỉ đổi nguồn tenant.
- **M6** `migrations/012_*.up.sql:39` — `paykit_api_keys_key_hash_idx` thừa (UNIQUE đã tạo index). Vì 012 chưa publish/chạy production, **sửa trực tiếp** file 012 (cả root + cli mirror) bỏ dòng index thừa, KHÔNG tạo migration mới.
- **M7** chỉ document: thêm comment ở `packages/server/src/db/repos/balance.repo.ts applyDelta` rằng balance âm là trạng thái hợp lệ (chargeback/refund sau rút) — không thêm guard (user xác nhận).

## Related Code Files
- Modify: `packages/server/src/routes/subscriptions/idempotency-middleware.ts`, `packages/server/src/db/repos/idempotency.repo.ts`
- Modify: `packages/server/src/auth/api-key.ts` (toBase62)
- Modify: `packages/server/src/routes/checkout/checkout-router.ts` (schema)
- Modify: `packages/server/src/routes/subscriptions/tenant-routes.ts`
- Modify: `packages/server/src/db/repos/balance.repo.ts` (comment only)
- Modify: `migrations/012_merchants_and_api_keys.up.sql` + `packages/cli/migrations/012_*.up.sql` (bỏ index thừa)
- Delete: `packages/server/src/routes/webhooks/stripe-handler.ts`, `sepay-handler.ts` (sau khi grep xác nhận unmount); cập nhật `packages/server/src/index.ts` bỏ export

## Implementation Steps
1. I2: thêm `lookupOrInsertIdempotency` trong idempotency.repo (insert placeholder, bắt unique-violation). Refactor middleware: insert-first trong tx; on conflict → replay nếu có response, else 409 `IDEMPOTENCY_IN_FLIGHT`. UPDATE response sau handler 2xx.
2. M1: viết lại `toBase62` injective; thêm test phân phối/độ dài + đảm bảo prefix `pk_live_`/`pk_test_` đúng.
3. M2: thêm `.multipleOf(0.01)` cho `amountUsd`.
4. M3: `grep -rn "stripe-handler\|sepay-handler\|buildStripeWebhookRoute\|buildSepayWebhookRoute"` toàn repo (gồm e2e/docs); nếu không có consumer thực → xóa 2 file + export.
5. M5: migrate tenant-routes sang `getAuthTenant`; thêm test scoping vẫn chặn cross-tenant.
6. M6: bỏ dòng `CREATE INDEX ... key_hash_idx` ở cả 2 file 012; chỉnh comment.
7. M7: thêm comment invariant ở `applyDelta`.
8. Build + chạy test toàn server + adapter.

## Success Criteria
- [ ] Hai request đồng thời cùng key chỉ một chạy handler (test concurrency)
- [ ] `toBase62` injective; key vẫn ≥256-bit entropy
- [ ] `amountUsd` >2 chữ số bị từ chối
- [ ] Dead-code handler đã xóa, build vẫn pass, không còn export mồ côi
- [ ] tenant-routes dùng auth context, scoping test xanh
- [ ] `pnpm build` toàn workspace pass; toàn bộ test xanh

## Risk Assessment
- I2 insert-first đổi luồng response của middleware — giữ nguyên mã lỗi body-mismatch (422) và missing-key (400); thêm 409 mới cần cập nhật doc/test.
- Xóa dead-code: rủi ro nếu có consumer ngoài repo; bắt buộc grep e2e + docs trước khi xóa, nếu nghi ngờ thì deprecate thay vì xóa.
- M1 đổi encoder KHÔNG ảnh hưởng key đã mint (kit chưa publish, chưa có key production) — xác nhận không có key thật trong DB trước khi đổi.
