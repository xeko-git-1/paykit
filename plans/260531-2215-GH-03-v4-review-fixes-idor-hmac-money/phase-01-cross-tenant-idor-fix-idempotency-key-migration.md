---
phase: 1
title: "Cross-tenant IDOR fix + idempotency-key migration"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Cross-tenant IDOR fix + idempotency-key migration

## Overview
Khắc phục lỗ hổng IDOR (finding **C1**, Critical): cột `idempotency_key` là `UNIQUE` toàn cục nên một tenant có thể đọc `transactionId` / `providerRef` / Stripe `checkoutUrl` của tenant khác chỉ bằng cách đoán Idempotency-Key. Sửa bằng cách (a) scope lookup theo `tenantId` và (b) đổi unique constraint sang `(tenant_id, idempotency_key)`.

## Requirements
- Functional: lookup idempotency phải scope theo tenant đã xác thực; replay đúng tenant vẫn trả kết quả cũ; key trùng giữa hai tenant không còn va chạm/đọc chéo.
- Non-functional: không phá vỡ replay idempotency hiện có; migration giữ được dữ liệu (kit chưa publish nhưng vẫn an toàn rollback).

## Architecture
Tenant lấy từ `getAuthTenant(c)` (auth-derived, đã đúng cho write tại `stripe-route.ts:118-119`). Vấn đề chỉ ở **read path**: `findByIdempotencyKey(db, key)` (`payment.repo.ts:47-54`) bỏ qua tenant. Thêm tham số `tenantId` và filter `and(eq(idempotencyKey, key), eq(tenantId, ...))`. Đồng thời đổi constraint DB để key chỉ unique trong phạm vi 1 tenant.

Phụ: `sepay-route.ts:76-88` còn 2 lỗi đi kèm — thiếu guard `providerRef !== null` (khác stripe-route) và regenerate QR bằng `parsed.amountVnd` **do caller cung cấp** thay vì amount đã lưu của transaction. Sửa để dùng amount đã lưu + thêm guard.

## Related Code Files
- Modify: `packages/server/src/db/repos/payment.repo.ts` — `findByIdempotencyKey(db, tenantId, key)` (47-54)
- Modify: `packages/server/src/db/schema/payment-transactions.ts` — bỏ `.unique()` đơn lẻ trên `idempotencyKey`, thêm composite unique `(tenantId, idempotencyKey)` (line 20)
- Modify: `packages/server/src/routes/checkout/checkout-router.ts` — call site `findByIdempotencyKey` (~122) truyền `tenant.tenantId`
- Modify: `packages/server/src/routes/checkout/stripe-route.ts` — call site (75) truyền `tenant.tenantId`
- Modify: `packages/server/src/routes/checkout/sepay-route.ts` — call site (76) truyền `tenant.tenantId`; thêm guard `existing.providerRef !== null`; regenerate QR bằng amount đã lưu (`existing.amountMicros`) không dùng `parsed.amountVnd`
- Create: `migrations/013_idempotency_key_tenant_scoped.up.sql` + `.down.sql`
- Create: `packages/cli/migrations/013_idempotency_key_tenant_scoped.up.sql` + `.down.sql` (mirror — 012 tồn tại ở cả hai)
- Modify: `migrations/manifest.json` + `packages/cli/migrations/manifest.json` — đăng ký 013

## Implementation Steps
1. Tìm tên constraint unique hiện tại: `psql ... -c "\d paykit.payment_transactions"` (thường `payment_transactions_idempotency_key_key`).
2. Viết `013_*.up.sql`: `ALTER TABLE paykit.payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_idempotency_key_key; ALTER TABLE paykit.payment_transactions ADD CONSTRAINT payment_transactions_tenant_idem_key UNIQUE (tenant_id, idempotency_key);`
3. Viết `013_*.down.sql`: đảo ngược (drop composite, re-add single-column unique).
4. Cập nhật cả 2 manifest.json (root + cli) theo format hiện có của 012.
5. Sửa drizzle schema `payment-transactions.ts`: bỏ `.unique()` ở `idempotencyKey`, thêm `uniqueIndex`/`unique` composite `(tenantId, idempotencyKey)` trong table extra-config callback.
6. Đổi chữ ký `findByIdempotencyKey(db, tenantId, key)` + filter `and(...)`.
7. Cập nhật 3 call site checkout; với sepay thêm guard providerRef + dùng amount đã lưu.
8. Thêm test regression: tenant A tạo tx với key `K`; tenant B gọi cùng key `K` → KHÔNG được thấy tx của A (phải tạo mới hoặc 404/empty), và replay của A với `K` vẫn trả tx cũ.

## Success Criteria
- [ ] `findByIdempotencyKey` không còn đường trả row của tenant khác (test chứng minh)
- [ ] Migration 013 lên/xuống chạy sạch trên DB có sẵn dữ liệu
- [ ] sepay-route không còn dùng `parsed.amountVnd` của caller khi replay
- [ ] `pnpm --filter @vibecc/paykit-server build` pass; test regression mới xanh

## Risk Assessment
- Đổi UNIQUE constraint trên cột live: nếu DB hiện có nhiều tenant cùng `idempotency_key` thì ADD composite vẫn an toàn (composite lỏng hơn). Rủi ro thấp vì kit chưa publish. Mitigation: `.down.sql` re-add single-unique chỉ chạy được nếu không có key trùng cross-tenant — ghi chú rõ trong file.
- Đổi chữ ký repo: TypeScript compiler bắt hết call site → an toàn.
