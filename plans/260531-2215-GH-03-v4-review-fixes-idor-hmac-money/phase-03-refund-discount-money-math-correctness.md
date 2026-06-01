---
phase: 3
title: "Discount money-math correctness (I4)"
status: pending
priority: P2
effort: "1h"
dependencies: []
---

# Phase 3: Discount money-math correctness (I4)

## Overview
**I3 đã bị loại bỏ — đã fix sẵn.** Red-team (3 reviewer độc lập) + đối chiếu lại HEAD xác nhận `refund-core.ts` (369 dòng, commit `f400f8c "refund reserve-then-reconcile with idempotent multi/partial refunds"`) đã giải quyết I3 bằng pattern **reserve-then-reconcile**: `sourceId` đã per-key (`tx:${transactionId}:${idempotencyKey}` tại `:133/:151/:317`), remaining-calc đã nằm trong tx đã `FOR UPDATE` (`:164-179`), và đã có test `packages/server/__tests__/refund-core-multi-refund.test.ts`. Review gốc đọc bản cũ (222 dòng) trước khi 2 commit này land trong cùng session.

Phase này giờ chỉ còn **I4**: discount % phân số bị `Math.round` làm sai số tiền.

## Requirements
- Functional: discount phân số (12.5%, 0.4%) tính đúng số tiền; không silently round tỉ lệ.
- Non-functional: giữ phép nhân tiền bằng bigint; clamp tránh underflow.

## Architecture
`packages/server/src/routes/checkout/apply-discount.ts:114` — `(amountMicros * BigInt(100 - Math.round(pct)) + 50n) / 100n`. `pct: number` (`packages/core/src/types/discount.ts`), `Math.round(pct)` biến 12.5→13, 0.4→0 (mất discount).
- Fix: dùng basis points integer. `bps = Math.round(pct * 100)`, clamp `[0, 10000]`, rồi `effective = (amountMicros * BigInt(10000 - bps) + 5000n) / 10000n`. Cho độ chính xác 0.01%. Sửa comment `:112-113` cho khớp (làm tròn nearest).

## Related Code Files
- Modify: `packages/server/src/routes/checkout/apply-discount.ts` (102-120)
- Reference: `packages/core/src/types/discount.ts` (kiểu `percent: number`)
- Test: `packages/server/__tests__/apply-discount.test.ts` (đã tồn tại — thêm case phân số)

## Implementation Steps
1. Thay `Math.round(pct)` bằng bps integer math; clamp bps vào `[0,10000]`.
2. Cập nhật clamp ngoài `[0,100]` ở `:103` cho nhất quán (vẫn full price nếu out-of-range).
3. Sửa comment `:112-113` mô tả đúng hướng làm tròn.
4. Thêm test: pct=12.5 → số tiền đúng theo bps (không round lên 13%); pct=0.4 → vẫn giảm, không thành 0; pct=100 → effective=0; pct=0 → full.

## Success Criteria
- [ ] Discount 12.5% / 0.4% / 100% / 0% tính đúng (test chứng minh)
- [ ] `pnpm --filter @vibecc/paykit-server build` pass; `apply-discount.test.ts` xanh

## Risk Assessment
- Thấp: thay đổi cục bộ một biểu thức. Clamp bps `[0,10000]` bắt buộc để tránh `BigInt(10000 - bps)` âm.

## Removed scope (red-team)
- **I3 (refund partial nuốt + remaining ngoài lock):** đã fix bởi reserve-then-reconcile (commit `f400f8c`). Không sửa `refund-core.ts`. Nếu muốn, chỉ bổ sung assertion vào `refund-core-multi-refund.test.ts` nếu phát hiện gap — KHÔNG đổi `sourceId` (sẽ phá dedup ở `:133/:151/:317`).
