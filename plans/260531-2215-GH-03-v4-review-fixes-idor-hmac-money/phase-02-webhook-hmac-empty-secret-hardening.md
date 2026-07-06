---
phase: 2
title: Webhook HMAC empty-secret hardening
status: completed
priority: P1
effort: 2h
dependencies: []
---

# Phase 2: Webhook HMAC empty-secret hardening

## Overview
Khắc phục finding **I1** (Important, gần Critical): 5 adapter HMAC lặp `for (const secret of secrets)` mà không bỏ qua secret rỗng. Nếu env unset → `""` → `createHmac(algo, "")` cho ra digest mà attacker tự tính được → forge webhook → credit ledger tùy ý. Chỉ NowPayments có guard. Đồng bộ tất cả adapter: skip secret rỗng + reject nếu không còn secret hợp lệ.

## Requirements
- Functional: secret rỗng **hoặc toàn whitespace** bị bỏ qua khi verify; nếu danh sách secret hợp lệ rỗng → verify trả `false` (fail-closed), không bao giờ accept.
- Non-functional: giữ nguyên timing-safe compare hiện có; không đổi behavior khi secret hợp lệ.

## Architecture
**Red-team finding K:** `if (secret === "") continue` (kể cả guard hiện có của NowPayments `webhook-verifier.ts:59`) KHÔNG bắt secret toàn whitespace — `!" "` và `!"\n"` đều `false`. Misconfig phổ biến: secret đọc từ file kèm trailing `\n`, hoặc placeholder `" "`. `createHmac("sha256", " ")` vẫn cho digest attacker tự tính được.
- Guard đúng: `if (!secret || secret.trim() === "") continue;` áp dụng cho **cả 5 adapter + sửa luôn NowPayments** (`webhook-verifier.ts:59`).
- Thêm: đếm số secret hợp lệ; nếu 0 thì return false sớm (mirror guard `secrets.length === 0` của Stripe).

## Related Code Files
- Modify: `packages/sepay-adapter/src/adapter.ts` — `verifyHmac` (44-57)
- Modify: `packages/server/src/providers/sepay/client.ts` — `verifyWebhookSignature`
- Modify: `packages/vnpay-adapter/src/signature.ts` (~30)
- Modify: `packages/momo-adapter/src/signature.ts` (~82)
- Modify: `packages/zalopay-adapter/src/signature.ts` (~62)
- Modify: `packages/nowpayments-adapter/src/webhook-verifier.ts` (~59) — nâng `=== ""` lên `.trim()` guard (finding K)

## Implementation Steps
1. Trong mỗi hàm verify, ngay đầu vòng lặp secret: `if (!secret || secret.trim() === "") continue;` (bắt cả `""`, `" "`, `"\n"`, `undefined`).
2. Theo dõi đã duyệt ít nhất 1 secret hợp lệ; nếu không có secret nào hợp lệ → return false (thêm guard tường minh + comment lý do).
3. Cân nhắc fail-fast tại factory `createXAdapter`: nếu cấu hình secret toàn rỗng/whitespace, throw lúc khởi tạo (tuỳ adapter — chỉ thêm nếu không phá test hiện có).
4. Thêm test cho từng adapter: `secrets = [""]`, `[" "]`, `["\n"]`, `["", ""]` + chữ ký bất kỳ tính bằng key đó → verify trả `false`; và secret hợp lệ vẫn verify đúng (chống hồi quy).

## Success Criteria
- [x] Cả 6 adapter (5 + NowPayments) bỏ qua secret rỗng/whitespace và fail-closed khi không có secret hợp lệ
- [x] Test forge-with-empty/whitespace-secret trả `false` cho từng adapter
- [x] `pnpm build` toàn workspace pass; test adapter xanh

## Risk Assessment
- Rủi ro thấp: thay đổi thuần phòng thủ, không đổi đường happy-path. Mitigation: test secret-hợp-lệ vẫn verify đúng để chứng minh không hồi quy.
