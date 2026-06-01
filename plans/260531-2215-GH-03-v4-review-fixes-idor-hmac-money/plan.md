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

Remediation cho các finding từ đợt code-review V4 (2026-05-31), đã qua red-team (2026-06-01). Mọi finding có `file:line`. Sau red-team: 1 Critical còn lại (cross-tenant IDOR), 2 Important (webhook forgery, idempotency concurrency), discount math + minors. **I3 (refund partial) đã bị loại — code đã fix sẵn bằng reserve-then-reconcile (commit `f400f8c`).**

**Context — tại sao:** V4 thay `TenantResolver` (caller cung cấp) bằng auth-derived tenant. Refactor làm lộ ra (a) read-path idempotency vẫn không scope tenant → IDOR; (b) các adapter HMAC không phòng thủ secret rỗng/whitespace; (c) idempotency middleware không an toàn concurrency. Đây là payment kit nên các lỗi này chặn ship.

**Quyết định sản phẩm (user xác nhận):**
- Nhiều lần refund từng phần: **đã được code hỗ trợ sẵn** (reserve-then-reconcile per-key sourceId) → I3 đóng, chỉ giữ test chứng minh nếu cần.
- Balance **được phép âm** có chủ đích (chargeback sau rút) → M7 chỉ document, không guard.
- I2 concurrency: fix bằng **migration + cột `state`** (in_flight|done) + TTL-reclaim (user chốt 2026-06-01).
- M6 (index thừa): **đóng**, giữ index (vô hại, test đang pin).

**Thứ tự thực thi (TUẦN TỰ — không parallel):** Phase 1 (C1) → Phase 2 (I1) → Phase 3 (I4) → Phase 4 (I2 + minors).
- Red-team finding E: KHÔNG parallel-safe. Phase 1 và Phase 4 cùng sửa `checkout-router.ts` (call-site vs schema), cùng thêm migration (013 rồi 014) + cùng sửa `v4-migrations-shape.test.ts`. Phase 4 `dependencies: [1]`.
- Phase 2 (adapter files) độc lập, có thể xen kẽ, nhưng giữ tuần tự cho đơn giản.

**Residual risk (red-team finding N, doc-only):** sau khi đóng C1, toàn bộ cô lập tenant phụ thuộc vào tính toàn vẹn của `tenant.tenantId`. Ở JWT plane, `jwt-middleware.ts:155-161` lấy `tenantId = payload.tenant_id ?? payload.sub` không cross-check với merchant. Nếu đường mint JWT cho phép client set `tenant_id` → confused-deputy vô hiệu hóa C1. KHÔNG nằm trong scope đợt này (chưa tìm thấy mint path trong repo, conf ~70%); ghi lại để verify khi wiring dashboard auth.

> Mode: `--tdd` — mỗi phase viết test regression trước/khi sửa. Nguồn finding: review session 2026-05-31 (xác minh trực tiếp + 3 subagent) → red-team 2026-06-01 (3 reviewer, 14 finding accepted).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Cross-tenant IDOR fix + idempotency-key migration](./phase-01-cross-tenant-idor-fix-idempotency-key-migration.md) | Pending |
| 2 | [Webhook HMAC empty-secret hardening](./phase-02-webhook-hmac-empty-secret-hardening.md) | Pending |
| 3 | [Discount money-math correctness (I4) — I3 đã fix sẵn](./phase-03-refund-discount-money-math-correctness.md) | Pending |
| 4 | [Idempotency concurrency + minor cleanup](./phase-04-idempotency-concurrency-minor-cleanup.md) | Pending (blockedBy: Phase 1) |

## Dependencies

- Code-mục tiêu sinh ra từ plan `260529-1312-GH-03-v4-service-shell-and-auth` (V4 auth/service). Plan này sửa lỗi của output đó nhưng **không** block nó — V4 plan có thể đã đánh dấu xong; các fix ở đây áp lên cùng file.
- Thay thế stub rỗng `260531-2144-GH-03-v4-review-remediation` (taxonomy cũ rộng hơn, gồm PCI/test-fidelity không có finding tương ứng). Stub đó nên archive/xoá để tránh trùng. Plan hiện tại chỉ gồm finding đã verify.

## Verification (end-to-end)

```bash
# Build toàn workspace
pnpm -r build

# Test server + adapter (string-match + unit; chứa regression mới mỗi phase)
pnpm --filter @vibecc/paykit-server test
pnpm -r --filter './packages/*-adapter' test

# Migration 013 (Phase 1) + 014 (Phase 4) — lên/xuống trên Postgres thật
pnpm --filter @vibecc/paykit-cli exec paykit migrate
psql "$PAYKIT_DB_URL" -c "\d paykit.payment_transactions"   # composite unique (tenant_id, idempotency_key)
psql "$PAYKIT_DB_URL" -c "\d paykit.idempotency_records"     # cột state + response_status nullable
```

**Harness (red-team finding F) — ĐÃ CHỐT: testcontainers/docker.** test migration-shape hiện có là **string-match thuần** (`v4-migrations-shape.test.ts` dùng `readFileSync`), KHÔNG chạm DB. Các test cần Postgres thật (IDOR cross-tenant INSERT, refund/idempotency concurrency, migration up/down) repo CHƯA có harness (grep pglite/testcontainers/pg = rỗng). Quyết định:
- Dùng **@testcontainers/postgresql** (Postgres thật qua Docker) — sát production, hỗ trợ advisory lock + `FOR UPDATE` chuẩn cho test concurrency.
- Đánh dấu test cần-DB là **integration**, tách khỏi `pnpm test` mặc định; chỉ chạy khi Docker khả dụng (skip có cảnh báo nếu thiếu, tránh đỏ giả trong CI trống).
- Dựng harness testcontainers là **việc đầu tiên của Phase 1** (block các success-criteria có chữ "test chứng minh"). Yêu cầu Docker trong môi trường CI chạy integration.

Mỗi phase có test regression riêng (xem Success Criteria). Critical/Important phải có test chứng minh trước khi đánh dấu hoàn tất.

## Red Team Review

### Session — 2026-06-01
**Findings:** 14 (14 accepted, 0 rejected) — tất cả có `file:line` evidence, qua evidence filter.
**Severity breakdown:** 2 Critical, 4 High, 7 Medium, 1 Low.
**Reviewers:** Security Adversary (Fact Checker), Assumption Destroyer (Scope Auditor), Failure Mode Analyst (Flow Tracer).

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| A | I3 đã fix sẵn (reserve-then-reconcile, commit f400f8c) — sửa theo plan gây regression | Critical | Accept | Phase 3 (gỡ I3) |
| B | I2 insert-first vi phạm `responseStatus NOT NULL` + poison-record khi handler crash | Critical | Accept | Phase 4 (migration+state) |
| C | Thêm migration 013/014 làm vỡ `v4-migrations-shape.test.ts` (pin count=12) | High | Accept | Phase 1 + 4 |
| D | M6 xóa index `key_hash` làm vỡ test pin index | High | Accept→đóng M6 | Phase 4 (giữ index) |
| E | Claim "parallel-safe" sai — checkout-router + migrations + test dùng chung | High | Accept | plan.md + Phase 4 dep |
| F | Không có Postgres test harness — mọi test migration là string-match | High | Accept | plan.md Verification |
| G | sepay fix sai đơn vị (`amountMicros` vào param VND) → QR sai 1e6 lần | Medium | Accept | Phase 1 step 8 |
| H | Down-migration 013 rollback hole (re-add single UNIQUE fail nếu key trùng) | Medium | Accept | Phase 1 (forward-only) |
| I | `DROP CONSTRAINT IF EXISTS` hardcode tên → silent no-op để lại global UNIQUE | Medium | Accept | Phase 1 step 1-2 |
| J | `findByProviderRef` vẫn unscoped (cùng class C1, latent) | Medium | Accept | Phase 1 (tenantId param) |
| K | Secret toàn whitespace vẫn bypass (`if(!secret)` không bắt `" "`) | Medium | Accept | Phase 2 (.trim()) |
| L | M5 blast radius lớn hơn (helper resolveTenant + buildIdempotencyMiddleware); M5+I2 cùng file | Medium | Accept | Phase 4 (refine) |
| M | M3 "bỏ export index.ts" — index.ts không export handler | Low | Accept | Phase 4 (sửa step) |
| N | JWT tin claim `tenant_id ?? sub` — residual risk sau C1 | Medium | Accept (doc-only) | plan.md residual-risk |

**Note:** Finding A do 3 reviewer độc lập phát hiện; mâu thuẫn với review gốc (đã đọc `refund-core.ts` bản 222 dòng). Đối chiếu lại HEAD (369 dòng, `git log` commit `f400f8c`/`b278132` land trong cùng session) xác nhận code đã refactor SAU review gốc → "context changed since verification", revise hợp lệ (không phải silent flip).

### Whole-Plan Consistency Sweep
- Decision delta: (1) I3 gỡ khỏi Phase 3 → title + overview + phases-table cập nhật. (2) I2 chuyển sang migration 014 + state column → Phase 4 + Verification. (3) M6 đóng → Phase 4 removed-scope. (4) parallel→sequential → overview + Phase 4 `dependencies:[1]`. (5) migration count 12→13→14 → Phase 1/4 đều thêm test-shape vào scope.
- Stale-term sweep: "I3/I4" trong Phase 3 task title (#1) còn cũ → cập nhật task. "song song/parallel" đã đổi thành tuần tự ở overview. Migration count nhất quán (013 Phase 1, 014 Phase 4).
- Còn 1 quyết định cần làm trước khi cook: **chốt Postgres harness** (finding F) — đã ghi là việc đầu Phase 1. Không phải contradiction, là prerequisite.
- Kết quả: **không còn mâu thuẫn chưa giải quyết.** Plan sẵn sàng cook sau khi chọn harness.
