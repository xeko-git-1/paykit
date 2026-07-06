---
phase: 4
title: "PCI redaction + test fidelity + docs"
status: completed
priority: P2
effort: "3-4h"
dependencies: [1, 2, 3]
---

# Phase 4: PCI redaction + test fidelity + docs

> **`blockedBy [1,2,3]`:** test-fidelity phải phản ánh code SAU khi P1-P3 sửa xong (vacuous test đang xanh giả).

## Overview

Đóng 2 red-team finding còn PARTIAL/untested (F13 redaction, F7 characterization) + sửa các
test "vacuous" (xanh nhưng không chứng minh gì) + đồng bộ docs với quyết định product.

## Requirements

**Functional (PCI — F13)**
- Redaction helper: review claim "`core/observability/redaction` wire vào log raw-body /v1" — helper
  **chưa tồn tại** (grep chỉ thấy comment "Phase 13 adds observability"). Hai hướng (chọn theo thực tế):
  - **(a)** Nếu /v1 KHÔNG log raw-body ở đâu cả → finding là "control claimed nhưng N/A": **document**
    rõ "no raw-body logging exists → no PAN-in-log path"; thêm guard test cấm thêm raw-body log sau này.
  - **(b)** Nếu có/sắp có raw-body log → **tạo** `packages/server/src/core/observability/redaction.ts`
    (mask field PAN-like: cardNumber/cvv/pan/...) + wire vào log path /v1.
  - **Đề xuất:** (a) — KISS, đúng hiện trạng (`.strict()` đã reject card field → 400 trước khi tới log).

**Test fidelity**
- **F7 characterization (I5):** thêm `packages/server/__tests__/admin-refund-route-characterization.test.ts`
  — khóa branch mapping admin refund (completed→ledger / pending→pending_refunds / pending_webhook→202 /
  unsupported / failed) + Idempotency-Key requirement. Chứng minh extract KHÔNG đổi hành vi admin.
- **refund-ownership vacuous (M5):** `refund-ownership.test.ts` assert "B not debited" vô giá trị
  (mock không mutate balance). Sửa: spy `executeRefund`/`applyDelta` **không được gọi** trên cross-tenant
  path (404 short-circuit), HOẶC mock thật sự debit để balance-assertion có nghĩa.
- **webhook-isolation yếu:** `webhook-route-isolation.test.ts:53` chỉ assert `!=401 && !=429` → pass cả
  khi handler 500. Sửa: assert 2xx/expected cho signed IPN (hoặc mock db hợp lệ).
- **rate-limit isolation (phụ thuộc P2):** nếu P2 chuyển sang per-keyId → cập nhật test dùng 2 key cùng merchant.

**Docs**
- README service / docs: document (1) mint = JWT-gated V4.4 + CLI seed cho V4.0; (2) suspension defer V4.x;
  (3) `mode` live/test non-isolated; (4) rate-limit soft/non-authoritative + Redis defer. Đồng bộ với quyết định product.
- M3 contract: `label`/`discountCode` advertised trong DTO nhưng không persist → hoặc implement, hoặc gỡ khỏi DTO + spec (tránh contract lừa).

## Related Code Files

- **Create (tùy hướng a/b):** `packages/server/src/core/observability/redaction.ts` (chỉ nếu (b))
- **Create:** `packages/server/__tests__/admin-refund-route-characterization.test.ts`
- **Modify:** `packages/service/__tests__/refund-ownership.test.ts` (spy thay vacuous assert)
- **Modify:** `packages/service/__tests__/webhook-route-isolation.test.ts` (assert mạnh)
- **Modify:** `packages/service/src/v1/dto.ts` + `openapi.ts` (M3: gỡ hoặc implement label/discountCode)
- **Modify:** README service + `docs/` liên quan (4 mục document)

## Implementation Steps (TDD)

1. Viết `admin-refund-route-characterization.test.ts` cho hành vi HIỆN TẠI (lock baseline) → PASS.
2. Sửa refund-ownership + webhook-isolation assertion → fail nếu protection bị gỡ (mutation-resistant).
3. F13: xác định có raw-body log /v1 không → chọn (a) document + guard test, hoặc (b) tạo redaction + wire.
4. M3: quyết định label/discountCode (gỡ hay implement) → đồng bộ DTO + spec.
5. Docs: cập nhật 4 mục.
6. **VERIFY:** `pnpm vitest run packages/service packages/server` → PASS; mọi assertion mới mutation-resistant (gỡ check thật → test đỏ).

## Success Criteria

- [x] Admin refund characterization test khóa branch mapping + idempotency (F7 proof thật)
- [x] refund-ownership + webhook-isolation test fail khi protection bị gỡ (hết vacuous)
- [x] F13 resolved: (a) documented no-log-path + guard test, HOẶC (b) redaction helper wire vào log
- [x] label/discountCode: implement hoặc gỡ khỏi public contract (không advertise field chết)
- [x] Docs đồng bộ: mint JWT-gated/CLI, suspension defer, mode non-isolated, rate-limit soft

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Characterization test khóa nhầm hành vi đã có bug | Low | Med | Đọc kỹ admin route hiện tại; nếu phát hiện bug → flag riêng, không "khóa" bug |
| Hướng (a) F13 bị coi là "bỏ qua PCI" | Low | Med | (a) chỉ hợp lệ nếu thật sự không có log path; thêm guard test cấm raw-body log → an toàn forward |
| Gỡ label/discountCode phá client đang gửi field đó | Low | Low | V4.0 chưa publish SDK; gỡ sớm an toàn hơn giữ field lừa |
