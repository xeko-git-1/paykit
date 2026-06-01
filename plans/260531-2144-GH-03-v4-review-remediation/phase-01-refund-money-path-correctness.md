---
phase: 1
title: "Refund money-path correctness"
status: completed
priority: P1
effort: "3-4h"
dependencies: []
---

# Phase 1: Refund money-path correctness

> **Critical money bug.** User đã chốt (2026-05-31): **multi/partial refund per transaction LÀ supported** → C1 là bug thật, logic `remaining`/`cumulative` là intent đúng cần giữ.

## Overview

`executeRefund` (`packages/server/src/services/refund-core.ts`) dedup ledger refund theo
`UNIQUE(provider, source_id, entry_type)` nhưng `sourceId` lại **hằng số mỗi transaction**
→ refund thứ 2 trên cùng tx bị nuốt âm thầm (`inserted:false`, không debit). Phase này sửa
khóa idempotency + đóng lỗ TOCTOU over-refund. Giờ merchant gọi được qua `/v1/refunds` nên
blast radius rộng hơn admin-only trước đây.

## Requirements

**Functional**
- Refund thứ 2..N trên cùng tx (khác `Idempotency-Key`, tổng ≤ original) PHẢI persist + debit.
- Retry cùng `Idempotency-Key` → vẫn dedup (trả kết quả cũ, không double-debit).
- `remaining` phải đếm ĐÚNG mọi prior refund của riêng tx đó, không bị giới hạn cửa sổ 200 row.
- Guard `exceeds_remaining` phải tính trong cùng lock với ledger-write (chống concurrent over-refund).

**Non-functional**
- KHÔNG đổi public DTO `/v1/refunds` (SDK contract ổn định).
- Admin refund path BEHAVIOR không đổi (Phase 4 thêm characterization test khóa điều này).

## Architecture / Root cause

```
refund-core.ts:182  sourceId = txRow.providerRef ?? `tx:${txRow.transactionId}`   ← CONSTANT/tx
refund-core.ts:183  appendLedgerEntryIdempotent → UNIQUE(provider, source_id, "refund")
   ⇒ refund #2 (Idempotency-Key khác, amount khác) → onConflictDoNothing → inserted:false → KHÔNG debit

refund-core.ts:67-72  listLedgerEntries({tenantId, entryType:"refund", limit:200})  ← tenant-wide, capped
refund-core.ts:73-77  .filter(originalTransactionId === tx)  ← in-memory sau khi đã cắt 200
   ⇒ merchant >200 refund gần đây trên tx KHÁC → prior refund của tx này rớt khỏi cửa sổ
   ⇒ cumulative undercount → remaining phồng → exceeds_remaining cho qua → OVER-REFUND

refund-core.ts:67 (remaining) tính NGOÀI db.transaction (line 173) ⇒ TOCTOU: 2 refund song song
   cùng đọc remaining cũ → cùng pass guard → tổng vượt original
```

## Related Code Files

- **Modify:** `packages/server/src/services/refund-core.ts` — sửa `sourceId`, đưa remaining-compute vào trong lock, đếm prior-refund theo `originalTransactionId` ở tầng DB.
- **Modify (nếu cần):** `packages/server/src/db/repos/ledger.repo.ts` — thêm query đếm/tổng refund theo `originalTransactionId` (SQL filter trên metadata hoặc cột), thay vì `listLedgerEntries` capped + in-memory filter.
- **Create (TEST FIRST):** `packages/server/__tests__/refund-core-multi-refund.test.ts`

## Implementation Steps (TDD) — Reserve-Then-Reconcile

**Approach:** RESERVE-THEN-RECONCILE pattern. The FOR UPDATE lock is held only for
the reservation phase (dedup check + remaining gate + insert pending_refund). The PSP
call happens outside the lock. Finalization (ledger + balance) happens in a second transaction.

1. **RED:** `refund-core-multi-refund.test.ts` — 14 tests covering:
   - Basic flow: reservation created → PSP called → ledger written → reservation completed
   - Distinct refunds (different keys) persist independently
   - Dedup-before-gate: retry of FULL refund returns completed (not 400 exceeds_remaining)
   - Dedup-before-gate: retry of partial refund deduplicates (no double-debit)
   - Concurrent over-refund: second refund rejected at remaining gate (reservation counted)
   - Mutation test: createPendingRefund called BEFORE adapter.refund
   - PSP failure → reservation marked failed, headroom released
   - PSP throws → reservation marked failed
   - Over-refund rejected, adapter NOT called
   - Full refund marks tx status='refunded'
   - Pending / pending_webhook paths preserve reservation
   - Provider unknown returns early
   - DB sum functions called with correct params

2. **GREEN:**
   - `refund-core.ts`: reserve-then-reconcile flow (tx1: lock+dedup+gate+reserve → PSP → tx2: finalize)
   - `pending-refund.repo.ts`: added `sumActiveReservationsByTransaction` + `findByProviderAndKey`
   - `ledger.repo.ts`: added `findLedgerEntryBySourceId` (read-only dedup check)
   - `sourceId = tx:${txRow.transactionId}:${idempotencyKey}` (distinct per key, dedup on retry)
   - remaining = original + committed_refunds(negative) - active_reservations(positive)

3. **VERIFY:** `pnpm --filter @vibecc/paykit-server build && pnpm vitest run packages/server` → 276 PASS.
   `pnpm vitest run packages/service` → 43 PASS. No regressions.

## Success Criteria

- [x] Refund #2 (khác Idempotency-Key) trên cùng tx persist + debit đúng
- [x] Retry cùng key → dedup, không double-debit
- [x] `remaining` đếm đủ prior refund của tx kể cả khi merchant có >200 refund khác
- [x] Over-refund concurrent bị chặn dưới lock (không vượt original)
- [x] Full server suite xanh; admin refund không hồi quy
- [x] Retry of FULL refund returns completed (not 400 exceeds_remaining) — Problem ① fixed
- [x] PSP never called for amount exceeding remaining — Problem ② fixed
- [x] PSP failure releases reservation headroom

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Đổi `sourceId` phá dedup retry (double-refund khi client retry) | Med | **Critical** | Khóa = `tx:{id}:{idempotencyKey}` → cùng key vẫn dedup; test retry explicit |
| Query đếm prior-refund theo metadata chậm/sai nếu metadata shape đổi | Low | High | Filter theo cột chuẩn nếu có; test cumulative nhiều refund |
| Đưa compute vào lock làm tăng thời gian giữ lock | Low | Low | Query nhẹ; chấp nhận để đảm bảo correctness |
