---
title: "Paykit V4 review fixes — cross-tenant IDOR + webhook HMAC + refund/discount money-math"
description: ""
status: pending
priority: P2
branch: "feat/v3-phase-03-nowpayments-adapter"
tags: []
blockedBy: []
blocks: []
created: "2026-05-31T15:28:55.636Z"
createdBy: "ck:plan"
source: skill
---

# Paykit V4 review fixes — cross-tenant IDOR + webhook HMAC + refund/discount money-math

## Overview

Remediation cho các finding từ đợt code-review V4 (2026-05-31). Mọi finding đã verify trực tiếp trên code (có `file:line`). Xếp theo blast radius: 1 Critical (cross-tenant data leak), 3 Important (webhook forgery, money-math refund/discount, idempotency concurrency), 6 Minor.

**Context — tại sao:** V4 thay `TenantResolver` (caller cung cấp) bằng auth-derived tenant. Refactor làm lộ ra (a) read-path idempotency vẫn không scope tenant → IDOR; (b) các adapter HMAC không phòng thủ secret rỗng; (c) refund money-math chưa hỗ trợ đúng nhiều partial; (d) idempotency middleware không an toàn concurrency. Đây là payment kit nên các lỗi này chặn ship.

**Quyết định sản phẩm (user xác nhận 2026-05-31):**
- Hỗ trợ **nhiều** lần refund từng phần → fix I3 bằng UNIQUE-per-refund (idempotencyKey trong sourceId).
- Balance **được phép âm** có chủ đích (chargeback sau rút) → M7 chỉ document, không guard.

**Thứ tự thực thi đề xuất:** Phase 1 (C1) → Phase 2 (I1) → Phase 3 (I3/I4) → Phase 4 (I2 + minors). Các phase độc lập về file, có thể chạy song song nếu cần, nhưng C1 + I1 ưu tiên cao nhất.

> Mode: `--tdd` — mỗi phase viết test regression trước/khi sửa. Nguồn finding: review session 2026-05-31 (xác minh trực tiếp + 3 subagent: tenant-isolation, webhook-signature, money-math).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Cross-tenant IDOR fix + idempotency-key migration](./phase-01-cross-tenant-idor-fix-idempotency-key-migration.md) | Pending |
| 2 | [Webhook HMAC empty-secret hardening](./phase-02-webhook-hmac-empty-secret-hardening.md) | Pending |
| 3 | [Refund + discount money-math correctness](./phase-03-refund-discount-money-math-correctness.md) | Pending |
| 4 | [Idempotency concurrency + minor cleanup](./phase-04-idempotency-concurrency-minor-cleanup.md) | Pending |

## Dependencies

- Code-mục tiêu sinh ra từ plan `260529-1312-GH-03-v4-service-shell-and-auth` (V4 auth/service). Plan này sửa lỗi của output đó nhưng **không** block nó — V4 plan có thể đã đánh dấu xong; các fix ở đây áp lên cùng file.
- Thay thế stub rỗng `260531-2144-GH-03-v4-review-remediation` (taxonomy cũ rộng hơn, gồm PCI/test-fidelity không có finding tương ứng). Stub đó nên archive/xoá để tránh trùng. Plan hiện tại chỉ gồm finding đã verify.

## Verification (end-to-end)

```bash
# Build toàn workspace
pnpm -r build

# Test server + adapter (chứa regression mới mỗi phase)
pnpm --filter @vibecc/paykit-server test
pnpm -r --filter './packages/*-adapter' test

# Migration 013 (Phase 1) — lên/xuống trên DB có dữ liệu
pnpm --filter @vibecc/paykit-cli exec paykit migrate
psql "$PAYKIT_DB_URL" -c "\d paykit.payment_transactions"   # xác nhận composite unique (tenant_id, idempotency_key)
```

Mỗi phase có test regression riêng (xem Success Criteria từng phase). Critical/Important phải có test chứng minh trước khi đánh dấu hoàn tất.
