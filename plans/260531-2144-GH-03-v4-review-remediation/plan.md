---
title: "Paykit V4.0 code-review remediation (refund money-path + auth wiring + ops hardening)"
description: "Khắc phục các finding từ parallel code-review V4.0 (3 reviewers): 1 Critical money-path (refund idempotency), wiring/contract gaps (mint dead, openapi behind auth, rate-limit key), ops hardening (readyz leak, shutdown, docker, migrate), PCI redaction + test fidelity."
status: pending
priority: P1
branch: "feat/v3-phase-03-nowpayments-adapter"
tags: [v4, remediation, refund, auth, ops, pci, code-review]
blockedBy: []
blocks: []
created: "2026-05-31T15:17:35.557Z"
createdBy: "ck:plan"
source: skill
---

# Paykit V4.0 code-review remediation

> **Nguồn:** parallel code-review V4.0 ngày 2026-05-31 (3 reviewers độc lập trên auth / service-shell / v1-api).
> Báo cáo gốc trong conversation; mọi finding đã verify build+test (305/305 pass) trước khi đưa vào đây.

## Overview

V4.0 đã code xong 5 phase (commit `b278132`, `318533a`) và pass 305 test, nhưng review phát
hiện **1 Critical money-path bug** + nhiều wiring/contract/ops gap. Plan này gom theo severity
+ theme, KHÔNG động lại 5 red-team finding gốc (F1-F14 đều verified PASS/PARTIAL — xem bảng dưới).

## Quyết định product đã chốt (user, 2026-05-31)

| # | Câu hỏi | Quyết định | Ảnh hưởng |
|---|---------|-----------|-----------|
| Q1 | Multi/partial refund per tx? | **CÓ — hỗ trợ** | C1 = bug Critical thật (không phải dead code). Phase 1 sửa sourceId |
| Q2 | `/v1/api-keys` mint hoạt động V4.0? | **Để Claude đề xuất → CLI seed** | Phase 2: thêm CLI `merchant:create`+`key:mint`; gỡ jwtSecretLoader chết; document HTTP mint = JWT-gated (V4.4) |
| Q3 | Enforce merchant suspension V4.0? | **DEFER V4.x** | Phase 3 chỉ DOCUMENT gap, KHÔNG enforce |
| Q4 | Cách xử lý batch | **Tạo plan đầy đủ** | Plan này |

## Red-team findings gốc (verified trong review — KHÔNG re-open)

F1 ✅ F2 ✅ F3 ✅(strong) F4 ✅ F5 ✅ F6 ✅ F9 ✅ F14 ✅ | F7 ⚠️ PASS-by-code (thiếu test chars → Phase 4) | F13 ⚠️ PARTIAL (`.strict()` có; redaction helper absent → Phase 4).

## Phases

| Phase | Name | Priority | Status |
|-------|------|----------|--------|
| 1 | [Refund money-path correctness](./phase-01-refund-money-path-correctness.md) | P1 | **Completed** (reserve-then-reconcile; sync ①② + async BUG A/B fixed; 369 tests) |
| 2 | [Auth wiring + contract fixes](./phase-02-auth-wiring-contract-fixes.md) | P1 | Pending |
| 3 | [Ops hardening + lifecycle](./phase-03-ops-hardening-lifecycle.md) | P2 | Pending |
| 4 | [PCI redaction + test fidelity + docs](./phase-04-pci-redaction-test-fidelity-docs.md) | P2 | Pending |

## Follow-ups spun off during Phase 1 review (tracked separately)

- **Reconciler ledger-write** (pre-existing V1.5) — DONE as part of Phase 1's reserve-then-reconcile completion (`packages/workers/v15-orchestrator.ts`).
- **Reconciler must not poll webhook-resolved providers** (NP/BitPay) — dormant until `reconcileV15` is scheduled with full registry; BLOCKS that wiring. Pre-existing.
- **Unify refund ledger `sourceId` scheme** across webhook (`evt.providerRef`) vs core/reconciler (`tx:{id}:{key}`) — latent double-debit, not reachable today; needs design decision.
- **Phase 4 must add a real `webhook-router` `payment.refunded` E2E test** — current BUG-A mutation test hand-simulates the webhook path; deleting the real release loop fails no test.

## Sequencing & file-ownership

- **Phase 1** (`refund-core.ts` + repo + tests) độc lập — cook trước (Critical money).
- **Phase 2** (`main.ts`, `v1/router.ts`, `v1/openapi.ts`, `v1/rate-limit.ts`, `auth-context.ts`, CLI) độc lập file với P1 → có thể cook sau P1 hoặc song song nếu cẩn thận ownership.
- **Phase 3** (`main.ts`, `health.ts`, `config.ts`, `Dockerfile`, `docker-compose.yml`) — **đụng `main.ts` với Phase 2** → P3 SAU P2 (tránh conflict cùng file).
- **Phase 4** (tests + redaction helper + docs) — `blockedBy [1,2,3]` vì test-fidelity phải phản ánh code cuối.

## Dependencies

- Cùng branch `feat/v3-phase-03-nowpayments-adapter` với plan V4.0 gốc (`260529-1312-GH-03-v4-service-shell-and-auth`).
- KHÔNG cần migration mới (012 đã land).

## Open questions

1. **Q3 (reviewer):** Dockerfile runtime stage copy `packages/cli/migrations` nhưng KHÔNG copy root `migrations/` — CLI `migrate` trong container tìm đúng chỗ chưa? → verify trong Phase 3.
2. **Rate-limit semantics:** per-key_id (theo comment/contract) hay per-merchant (theo code hiện tại)? → Phase 2 đề xuất expose `keyId` vào auth context để khớp contract; cần user xác nhận nếu muốn giữ per-merchant.
