---
phase: 2
title: "Webhook HMAC empty-secret hardening"
status: pending
priority: P1
effort: "2h"
dependencies: []
---

# Phase 2: Webhook HMAC empty-secret hardening

## Overview
Khắc phục finding **I1** (Important, gần Critical): 5 adapter HMAC lặp `for (const secret of secrets)` mà không bỏ qua secret rỗng. Nếu env unset → `""` → `createHmac(algo, "")` cho ra digest mà attacker tự tính được → forge webhook → credit ledger tùy ý. Chỉ NowPayments có guard. Đồng bộ tất cả adapter: skip secret rỗng + reject nếu không còn secret hợp lệ.

## Requirements
- Functional: secret rỗng/whitespace bị bỏ qua khi verify; nếu danh sách secret hợp lệ rỗng → verify trả `false` (fail-closed), không bao giờ accept.
- Non-functional: giữ nguyên timing-safe compare hiện có; không đổi behavior khi secret hợp lệ.

## Architecture
Pattern chuẩn (NowPayments `webhook-verifier.ts:59`): trong vòng lặp `if (secret === "") continue;`. Cần thêm: đếm số secret hợp lệ; nếu 0 thì return false sớm (mirror guard `secrets.length === 0` của Stripe). Áp dụng cho từng adapter có HMAC thủ công.

## Related Code Files
- Modify: `packages/sepay-adapter/src/adapter.ts` — `verifyHmac` (44-57)
- Modify: `packages/server/src/providers/sepay/client.ts` — `verifyWebhookSignature`
- Modify: `packages/vnpay-adapter/src/signature.ts` (~30)
- Modify: `packages/momo-adapter/src/signature.ts` (~82)
- Modify: `packages/zalopay-adapter/src/signature.ts` (~62)
- Reference (đã đúng, không sửa): `packages/nowpayments-adapter/src/webhook-verifier.ts:59`

## Implementation Steps
1. Trong mỗi hàm verify, ngay đầu vòng lặp secret: `if (!secret) continue;` (bắt cả `""`, `undefined`).
2. Theo dõi đã duyệt ít nhất 1 secret hợp lệ; nếu không có secret nào hợp lệ → return false (không để vòng lặp rỗng ngầm trả false đã ok, nhưng thêm guard tường minh + comment lý do).
3. Cân nhắc fail-fast tại factory `createXAdapter`: nếu cấu hình secret toàn rỗng, throw lúc khởi tạo (tuỳ adapter — chỉ thêm nếu không phá test hiện có).
4. Thêm test: secret = `""` (và mảng `["", ""]`) + chữ ký bất kỳ tính bằng key rỗng → verify trả `false`.

## Success Criteria
- [ ] Cả 5 adapter bỏ qua secret rỗng và fail-closed khi không có secret hợp lệ
- [ ] Test forge-with-empty-secret trả `false` cho từng adapter
- [ ] `pnpm build` toàn workspace pass; test adapter xanh

## Risk Assessment
- Rủi ro thấp: thay đổi thuần phòng thủ, không đổi đường happy-path. Mitigation: test secret-hợp-lệ vẫn verify đúng để chứng minh không hồi quy.
