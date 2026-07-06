---
phase: 1
title: Cross-tenant IDOR fix + idempotency-key migration
status: completed
priority: P1
effort: 4h
dependencies: []
---

# Phase 1: Cross-tenant IDOR fix + idempotency-key migration

## Overview
Khắc phục lỗ hổng IDOR (finding **C1**, Critical): cột `idempotency_key` là `UNIQUE` toàn cục nên một tenant có thể đọc `transactionId` / `providerRef` / Stripe `checkoutUrl` của tenant khác chỉ bằng cách đoán Idempotency-Key. Sửa bằng cách (a) scope lookup theo `tenantId` và (b) đổi unique constraint sang `(tenant_id, idempotency_key)`. Kèm finding J: `findByProviderRef` cũng unscoped (cùng class bug).

## Requirements
- Functional: lookup idempotency phải scope theo tenant đã xác thực; replay đúng tenant vẫn trả kết quả cũ; key trùng giữa hai tenant không còn va chạm/đọc chéo.
- Non-functional: không phá vỡ replay idempotency hiện có; migration giữ được dữ liệu (kit chưa publish nhưng vẫn an toàn rollback).

## Architecture
Tenant lấy từ `getAuthTenant(c)` (auth-derived, đã đúng cho write tại `stripe-route.ts:118-119`). Vấn đề chỉ ở **read path**: `findByIdempotencyKey(db, key)` (`payment.repo.ts:47-54`) bỏ qua tenant. Thêm tham số `tenantId` và filter `and(eq(idempotencyKey, key), eq(tenantId, ...))`. Đồng thời đổi constraint DB để key chỉ unique trong phạm vi 1 tenant.

**Finding J — `findByProviderRef` (`payment.repo.ts:56-67`) cũng unscoped** theo `(provider, providerRef)`. Hiện chưa có route user-facing gọi nó (webhook-router tự `select` inline, signature-gated) nên là latent, nhưng plan tuyên bố đóng class bug "đọc chéo qua cột globally-unique" thì phải xử lý: thêm `tenantId` param HOẶC để nguyên + thêm comment cảnh báo "webhook-only, không wire vào route user-facing không scoped". Quyết định: thêm `tenantId` optional + comment, không ép breaking nếu webhook caller không có tenant.

Phụ (sepay): `sepay-route.ts:76-88` còn 2 lỗi đi kèm — thiếu guard `providerRef !== null` (khác stripe-route) và regenerate QR bằng `parsed.amountVnd` **do caller cung cấp** thay vì amount đã lưu.

## Related Code Files
- Modify: `packages/server/src/db/repos/payment.repo.ts` — `findByIdempotencyKey(db, tenantId, key)` (47-54); `findByProviderRef` (+tenantId optional, 56-67)
- Modify: `packages/server/src/db/schema/payment-transactions.ts` — bỏ `.unique()` đơn lẻ trên `idempotencyKey` (line 20), thêm composite unique `(tenantId, idempotencyKey)` qua **table extra-config callback** (pattern y hệt `idempotency-records.ts:24-26` `(table) => ({...})`)
- Modify: `packages/server/src/routes/checkout/checkout-router.ts` — call site `findByIdempotencyKey` (~122) truyền `tenant.tenantId`
- Modify: `packages/server/src/routes/checkout/stripe-route.ts` — call site (75) truyền `tenant.tenantId`
- Modify: `packages/server/src/routes/checkout/sepay-route.ts` — call site (76) truyền `tenant.tenantId`; thêm guard `existing.providerRef !== null`; regenerate QR bằng amount đã lưu **đã convert micros→VND**
- Create: `migrations/013_idempotency_key_tenant_scoped.up.sql` + `.down.sql`
- Create: `packages/cli/migrations/013_idempotency_key_tenant_scoped.up.sql` + `.down.sql` (mirror)
- Modify: `migrations/manifest.json` + `packages/cli/migrations/manifest.json` — đăng ký 013
- Modify (test, finding C): `packages/server/__tests__/v4-migrations-shape.test.ts` — `toBe(12)`→`toBe(13)` (`:81`), thêm assertion shape cho 013, manifest "last id"=`013` (`:67`)

## Implementation Steps
1. **BẮT BUỘC (finding I):** lấy tên constraint thật, không đoán: `psql "$PAYKIT_DB_URL" -c "\d paykit.payment_transactions"` (gốc từ `001_init.up.sql:18` column-level UNIQUE → auto-name `payment_transactions_idempotency_key_key`, KHÔNG đảm bảo cố định).
2. Viết `013_*.up.sql`: `ALTER TABLE paykit.payment_transactions DROP CONSTRAINT <ten_that>; ALTER TABLE paykit.payment_transactions ADD CONSTRAINT payment_transactions_tenant_idem_key UNIQUE (tenant_id, idempotency_key);` — dùng tên thật từ bước 1; nếu lo ngại lệch tên giữa môi trường, drop động qua `pg_constraint` (DO block tìm conname theo `contype='u'` trên cột idempotency_key).
3. **Finding H — down-migration là forward-only-an-toàn:** `013_*.down.sql` re-add single-column UNIQUE **chỉ** chạy được nếu chưa có key trùng cross-tenant. Ghi comment rõ "down KHÔNG an toàn sau khi có dữ liệu cross-tenant; coi 013 là forward-only". Tùy chọn: bọc re-add trong DO block kiểm tra `NOT EXISTS (... GROUP BY idempotency_key HAVING count(*)>1)`, ngược lại RAISE NOTICE + bỏ qua.
4. Cập nhật cả 2 manifest.json (root + cli) theo format 012.
5. Sửa drizzle schema `payment-transactions.ts`: bỏ `.unique()` ở `idempotencyKey`, thêm composite unique trong table extra-config callback (tham chiếu `idempotency-records.ts:24-26`).
6. Đổi chữ ký `findByIdempotencyKey(db, tenantId, key)` + filter `and(...)`. Thêm `tenantId` optional cho `findByProviderRef` + comment (finding J).
7. Cập nhật 3 call site checkout (TS compiler bắt hết — nhưng **finding-D**: grep xác nhận không còn caller nào ngoài 3 route + tests trước khi đổi).
8. **Finding G — sepay đơn vị:** ở replay path convert micros→VND trước khi gọi `generateQrUrl(orderId, amountVnd:number)` (`client.ts:61`). Không có helper `microsToVnd`, dùng `Number(BigInt(existing.amountMicros.split(".")[0]) / 1_000_000n)` (giống `sepay-route.ts:144`). Tuyệt đối không truyền chuỗi `amountMicros` thẳng vào.
9. **Finding C — update test:** sửa `v4-migrations-shape.test.ts` count 12→13 + shape 013 (cùng commit, nếu không `pnpm test` đỏ).
10. Thêm test regression IDOR: tenant A tạo tx với key `K`; tenant B gọi cùng key `K` → KHÔNG thấy tx của A; replay của A với `K` vẫn trả tx cũ. **Finding I:** sau 013, tenant A+B cùng key cùng INSERT thành công (không 500 do constraint cũ sót lại).

## Success Criteria
- [x] `findByIdempotencyKey` không còn đường trả row của tenant khác (test chứng minh)
- [x] `findByProviderRef` có tenantId param hoặc comment cảnh báo rõ (finding J)
- [x] Migration 013 lên chạy sạch; down có guard/comment forward-only (finding H)
- [x] sepay-route replay dùng amount đã lưu, convert đúng micros→VND (finding G)
- [x] `v4-migrations-shape.test.ts` cập nhật 13 migration, xanh (finding C)
- [x] `pnpm --filter @vibecc/paykit-server build` pass; test regression IDOR xanh

## Risk Assessment
- **Finding I:** `DROP CONSTRAINT IF EXISTS <ten_doan>` có thể silent no-op nếu tên lệch → constraint global-unique sót lại → tenant B INSERT key trùng → 500. Mitigation: bước 1 (lấy tên thật) BẮT BUỘC + test A/B cùng key INSERT thành công.
- **Finding H:** down 013 không reversible sau khi có dữ liệu cross-tenant — document forward-only.
- Đổi chữ ký repo: TypeScript compiler bắt call site; grep xác nhận tests cũng được cập nhật.
- **Finding F (harness):** test migration hiện là string-match (`readFileSync`), KHÔNG chạm DB; test IDOR/INSERT-A-B cần Postgres thật → xem ghi chú harness ở plan.md (đánh dấu integration, không gộp `pnpm test` mặc định nếu CI thiếu Postgres).
