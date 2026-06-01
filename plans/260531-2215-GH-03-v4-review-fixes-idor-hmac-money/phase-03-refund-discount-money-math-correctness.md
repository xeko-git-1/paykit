---
phase: 3
title: "Refund + discount money-math correctness"
status: pending
priority: P1
effort: "4h"
dependencies: []
---

# Phase 3: Refund + discount money-math correctness

## Overview
Hai lỗi money-math: **I3** (refund partial thứ 2 bị nuốt do `sourceId` dùng chung + `remaining` đọc ngoài tx đã lock) và **I4** (discount % phân số bị `Math.round` làm sai số tiền). Quyết định sản phẩm: **hỗ trợ nhiều lần refund từng phần** → fix theo hướng cho mỗi refund một UNIQUE riêng và tính lại remaining trong tx đã khóa.

## Requirements
- Functional: refund từng phần nhiều lần được apply đúng tới tổng = số tiền gốc; refund vượt remaining bị từ chối (`exceeds_remaining`); discount phân số (12.5%, 0.4%) tính đúng số tiền.
- Non-functional: an toàn concurrency (hai refund đồng thời không vượt remaining); replay đúng nghĩa idempotent (cùng `idempotencyKey` không double-debit).

## Architecture
**I3 — `packages/server/src/services/refund-core.ts`:**
- `sourceId = txRow.providerRef ?? tx:${txRow.transactionId}` (**line 182**) dùng chung cho mọi refund của một tx. UNIQUE `(provider, source_id, entry_type='refund')` khiến refund partial lần 2 rơi vào `onConflictDoNothing` → `inserted=false` → `applyDelta` bị bỏ (line 201) → trả `state:completed, inserted:false` (map thành `"duplicate"` ở route). Tiền lần 2 không bao giờ vào ledger.
  - Fix: đưa `idempotencyKey` vào `sourceId` (vd `${base}:${idempotencyKey}`) để mỗi lần refund hợp lệ có UNIQUE riêng, đồng thời vẫn idempotent theo `idempotencyKey` (replay cùng key → trùng → không double). Đây là cách giữ cả hai tính chất: phân biệt partial khác nhau + chống replay.
- `remaining` tính qua `listLedgerEntries(db, ...)` (**line 67**, dùng `db` không phải `tx`) **trước** khi lấy `FOR UPDATE` (line 173-180). Hai refund đồng thời cùng đọc remaining cũ → cùng pass guard line 85.
  - Fix: di chuyển phần tính `priorRefunds`/`cumulative`/`remaining` + guard `exceeds_remaining` **vào trong** `db.transaction` sau khi đã `SELECT ... FOR UPDATE`, để guard chạy dưới khóa hàng.

**I4 — `packages/server/src/routes/checkout/apply-discount.ts:114`:**
- `(amountMicros * BigInt(100 - Math.round(pct)) + 50n) / 100n` — `pct: number`, `Math.round(pct)` biến 12.5→13, 0.4→0.
  - Fix: dùng basis points integer. Đổi sang `pct` → bps = `Math.round(pct * 100)` (clamp [0,10000]) rồi `effective = (amountMicros * BigInt(10000 - bps) + 5000n) / 10000n`. Cho phép độ chính xác 0.01%. Sửa luôn comment line 112-113 cho khớp hướng làm tròn (nearest).

## Related Code Files
- Modify: `packages/server/src/services/refund-core.ts` — `sourceId` (182), di chuyển remaining-calc + guard vào tx (67-87 → trong block 173-214)
- Modify: `packages/server/src/routes/checkout/apply-discount.ts` — bps math (102-120)
- Reference: `packages/server/src/db/repos/ledger.repo.ts` — `appendLedgerEntryIdempotent` UNIQUE coords (xác nhận `source_id` nằm trong unique key trước khi đổi)

## Implementation Steps
1. Đọc `ledger.repo.ts appendLedgerEntryIdempotent` + migration `009_ledger_v2_columns` để xác nhận UNIQUE `(provider, source_id, entry_type)`.
2. I3a: refactor `executeRefund` — chuyển khối tính remaining (67-87) vào trong `db.transaction`, đặt **sau** `SELECT FOR UPDATE`, dùng `tx` thay `db`. Trả `exceeds_remaining` từ trong tx.
3. I3b: đổi `sourceId` thành chuỗi gồm `idempotencyKey` để partial khác nhau có coord khác nhau; giữ idempotent theo key.
4. I4: thay `Math.round(pct)` bằng bps integer math trong `apply-discount.ts`; cập nhật clamp + comment.
5. Test I3: 1 tx $100 → refund $30 rồi $30 → ledger có 2 entry, balance giảm $60, lần 2 KHÔNG bị nuốt; refund $50 nữa khi remaining $40 → `exceeds_remaining`; replay cùng `idempotencyKey` → không double-debit.
6. Test I4: pct=12.5 trên amount → số tiền đúng theo bps (không bị round lên 13%); pct=0.4 → vẫn giảm, không thành 0.

## Success Criteria
- [ ] Nhiều refund partial apply đúng; tổng refund không vượt gốc; concurrency-safe (guard trong tx đã lock)
- [ ] Replay refund cùng `idempotencyKey` không double-debit
- [ ] Discount 12.5% / 0.4% tính đúng (test chứng minh)
- [ ] `pnpm --filter @vibecc/paykit-server build` pass; test money-math xanh

## Risk Assessment
- Đổi `sourceId` ảnh hưởng ngữ nghĩa idempotent: phải đảm bảo replay cùng key vẫn trùng coord (do key nằm trong sourceId) → test replay bắt buộc.
- Di chuyển remaining-calc vào tx có thể đổi thứ tự lỗi trả về; giữ nguyên mã lỗi `exceeds_remaining` để route mapping (refund-route.ts:91) không đổi.
- bps math: clamp bps vào [0,10000] để tránh underflow `BigInt(10000 - bps)`.

## Notes (out of scope, flag only)
- M7 negative balance: user xác nhận **cho phép âm có chủ đích** → không thêm guard, chỉ document invariant ở Phase 4.
- Underpayment guard (SePay) chỉ tồn tại ở `sepay-handler.ts` (dead code). Việc router credit đúng số tiền thực trả cho QR là hợp lý về mặt sản phẩm → KHÔNG port guard trong đợt này; xử lý dead-code ở Phase 4.
