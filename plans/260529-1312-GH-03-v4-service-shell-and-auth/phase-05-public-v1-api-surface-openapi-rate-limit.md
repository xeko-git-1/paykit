---
phase: 5
title: "Public /v1 API surface + OpenAPI + rate-limit"
status: completed
priority: P1
effort: "6-8h"
dependencies: [4]
---

# Phase 5: Public /v1 API surface + OpenAPI + rate-limit

> **Red-team applied (2026-05-29):** F3 (mint escalation) → mint JWT/admin-plane only,
> `merchantId` từ caller (không body), minted-scopes ⊆ caller-scopes. F4 (refund IDOR) →
> `/v1/refunds` PHẢI assert `txRow.tenantId === paykitAuth.tenant.tenantId`. F7 (refund
> coupling) → extract guard-agnostic refund-core, KHÔNG "wrap" admin route. F8 (OpenAPI
> fiction) → routes hand-rolled + schema chưa export + generator chưa có dep + zod-v4 peer
> risk → chốt cách build spec trước. F13 (PCI) → `zod.strict()` + negative PAN test.
> F14 → rate-limit KHÔNG phải control cho mint; effort 3h→6-8h.

> **Validation Session 1 (2026-05-29):** F8 → chốt **`@hono/zod-openapi` (rewrite route)**,
> verify zod-v4.4.3 peer-compat TRƯỚC (blocking gate). F14 → mint thêm **per-merchant
> DB-counted cap Ở V4.0** (không defer). D2 → `mode` non-isolated, document only.

## Overview

Đóng băng mặt ngoài service: versioned `/v1` surface (request/response shape ổn định cho
SDK V4.4), OpenAPI 3.1 spec, rate-limit per-key in-memory. Hợp đồng public — phải nhất quán.

## Requirements

**Functional**
- `/v1` endpoints (mount ở phase 4, phase này định hình DTO + version + scope):
  - `POST /v1/checkouts` (scope `checkout:write`) → checkout-core hiện có
  - `GET /v1/balances` (scope `balance:read`)
  - `GET /v1/payments` (scope `payments:read`)
  - `POST /v1/refunds` (scope `refunds:write`) — **F4 + F7, KHÔNG "reuse" trực tiếp:**
    - **F7:** extract refund-core guard-agnostic (lookup→compute remaining→`adapter.refund`→branch→ledger) ra hàm nhận `actor: {merchantId} | {adminUserId,role}` + `tenantId`; admin route hiện tại VÀ `/v1/refunds` cùng gọi. KHÔNG mount `adminGuardMiddleware` bên trong (nó đọc `c.get('adminContext')` → undefined trên api-key plane → NPE/audit rác).
    - **F4 ownership:** sau khi load `txRow`, reject 404 nếu `txRow.tenantId !== paykitAuth.tenant.tenantId`. Admin refund route hiện lookup tx **chỉ theo `transactionId`, KHÔNG filter tenant** (`refund-route.ts:81-86`) — an toàn cho admin plane (trusted, operator-wide) nhưng IDOR trên merchant plane.
  - `POST /v1/api-keys` (mint) — **F3, JWT/admin plane ONLY** (reject api_key plane, thực thi D1); `merchantId` lấy từ `paykitAuth.merchantId` (KHÔNG từ body); minted-scopes phải ⊆ caller-scopes (`isScopeSubset` phase 2). **F14: per-merchant DB-counted cap** — đếm key active của merchant trong DB; vượt ngưỡng → 429 (durable, multi-instance-safe; KHÔNG dựa in-memory rate-limit). Trả plaintext đúng 1 lần.
- **Error envelope thống nhất:** `{ error: { code, message } }` (`errorJson`/`response.ts`) — version-stable.
- **OpenAPI 3.1 spec (F8 — Validation S1 CHỐT option (b)):** **`@hono/zod-openapi` (`OpenAPIHono`+`createRoute`)** — chấp nhận **rewrite route** `/v1` theo style mới (KHÔNG dùng zod-to-openapi). Routes hiện là `app.get/post` hand-rolled với `schema.parse(body)` inline (`checkout-router.ts:73`), schema chưa export; zod cài là **v4.4.3**. **Blocking gate:** verify `@hono/zod-openapi` peer-compat với zod-v4.4.3 TRƯỚC khi thêm dep — nếu incompatible, DỪNG + escalate (không tự đổi sang zod-to-openapi mà không hỏi). Spec derive trực tiếp từ `createRoute` definitions → không drift.
  Verify zod-v4 compat TRƯỚC khi thêm dep. Serve `GET /v1/openapi.json`.
- **Rate-limit:** per-`key_id` in-memory token bucket (D7), `X-RateLimit-*`, 429. **F14:** in-memory KHÔNG authoritative khi multi-instance (Docker scale) — chỉ là soft per-process throttle. **Mint abuse control = JWT/admin plane + scope-subset + per-merchant DB-counted cap (Validation S1: thêm Ở V4.0, durable, multi-instance-safe)** — KHÔNG dựa vào in-memory rate-limit. Redis path cho rate-limit chung comment defer.

**Non-functional**
- **F13 PCI:** mọi `/v1` DTO dùng `zod.strict()` (reject unknown keys → 400); negative test body chứa `cardNumber`/`cvv` → 400; redaction helper (`core/observability/redaction`) wire vào log raw-body của `/v1`.
- DTO có `apiVersion`; breaking → `/v2`, không sửa `/v1`.
- Rate-limit + scope KHÔNG chạm webhook (F2 phase 4: webhook top-level).

## Architecture

```
/v1 (versioned, OpenAPI-described)
  ├─ POST /checkouts   [api_key, checkout:write]  → checkout-core
  ├─ GET  /balances    [api_key, balance:read]    → balance repo (tenant-scoped)
  ├─ GET  /payments    [api_key, payments:read]   → history repo
  ├─ POST /refunds     [api_key, refunds:write]   → refund-CORE (extracted, F7)
  │                                                  + ownership check txRow.tenantId==auth (F4)
  ├─ POST /api-keys     [JWT/admin ONLY, F3]        → mint: merchantId from auth,
  │                                                   scopes ⊆ caller (isScopeSubset)
  ├─ GET  /openapi.json                            → spec (F8: from exported zod)
  └─ (all /v1) rate-limit per key_id → 429   (soft, non-authoritative multi-instance — F14)

refund-core(actor, tenantId, txId, amount)  ←── admin-refund-route (adminContext actor)
                                             └── /v1/refunds (merchant actor + ownership)
```

## Related Code Files

- **Create:** `packages/service/src/v1/dto.ts` (zod `.strict()` schemas — F13; export-able single source)
- **Create:** `packages/service/src/v1/openapi.ts` (F8: `OpenAPIHono` app + `createRoute` defs; serve `getOpenAPIDocument()`)
- **Create:** `packages/service/src/v1/rate-limit.ts` (in-memory token bucket per key_id)
- **Create:** `packages/service/src/v1/router.ts` (wire endpoints + scope + plane + rate-limit)
- **Modify:** `packages/server/src/routes/admin/refund-route.ts` — **F7 extract** refund-core ra `packages/server/src/services/refund-core.ts` (guard-agnostic, nhận actor + tenantId); admin route gọi core. Export core từ barrel.
- **Create:** `packages/server/src/services/refund-core.ts`
- **Modify:** `packages/server/src/index.ts` — export refund-core (F7). **F8:** route `/v1` viết bằng `OpenAPIHono`+`createRoute` (rewrite), schema định nghĩa inline trong service `dto.ts` — không cần export schema từ server barrel.
- **Modify:** `packages/service/src/main.ts` (mount `/v1/router` + `/v1/openapi.json`)
- **Create (TEST FIRST):** `v1-contract.test.ts`, `rate-limit.test.ts`, `openapi-spec.test.ts`, `refund-ownership.test.ts`, `mint-escalation.test.ts`, `pci-strict-dto.test.ts`

## Implementation Steps (TDD)

1. **RED:**
   - `v1-contract.test.ts`: key + scope đúng → 2xx khớp DTO; thiếu scope → 403; sai input → 400 envelope.
   - **`refund-ownership.test.ts` (F4):** merchant A key refund tx của merchant B → 404/403, KHÔNG debit B. Merchant A refund tx của chính A → OK.
   - **`mint-escalation.test.ts` (F3 + F14):** api_key plane gọi `/v1/api-keys` → 401 (plane reject); caller scope `[keys:manage]` mint key scope `[refunds:write]` → 403 (không subset); `merchantId` body ≠ auth → bị bỏ qua, dùng auth; **per-merchant DB cap: mint vượt ngưỡng key active → 429 (durable, không reset khi restart)**.
   - **`pci-strict-dto.test.ts` (F13):** body `{...valid, cardNumber, cvv}` → 400 (zod.strict reject unknown).
   - `rate-limit.test.ts`: N → 200, N+1 → 429 + header; isolation per key_id.
   - `openapi-spec.test.ts`: `/v1/openapi.json` → `openapi:3.1`, paths khớp router, components từ zod.
   Chạy → FAIL.
2. **GREEN:**
   - **F7 extract** refund-core trước (test admin refund hiện có vẫn xanh — characterization).
   - DTO `.strict()` (F13); router scope+plane-gated; `/v1/refunds` gọi core + ownership (F4); mint JWT-only + subset (F3); rate-limit; openapi (cách F8 đã chốt).
   - KHÔNG viết lại business logic checkout/balance/history (chỉ bọc version+scope); refund LÀ extract thật sự (không phải wrap).
3. **VERIFY:** `pnpm --filter @vibecc/paykit-service build && pnpm --filter @vibecc/paykit-server build && pnpm vitest run packages/service packages/server` → PASS. Admin refund suite cũ vẫn xanh (F7 không hồi quy).

## Success Criteria

- [ ] Mọi `/v1` scope-gated (403 thiếu scope, 401 thiếu key/sai plane)
- [ ] **F4:** merchant không refund được tx của merchant khác (404, không debit)
- [ ] **F3 + F14:** mint = JWT/admin plane only; merchantId từ auth; scopes ⊆ caller; per-merchant DB-counted cap → 429 khi vượt (durable)
- [ ] **F7:** refund-core extracted; admin refund route cũ vẫn xanh (không hồi quy)
- [ ] **F13:** DTO `.strict()`; body card-like → 400; redaction wire log `/v1`
- [ ] **F8:** `/v1/openapi.json` spec 3.1 hợp lệ; cách build chốt + zod-v4 verified
- [ ] **F14:** rate-limit 429/header, isolation per key_id; KHÔNG là control duy nhất cho mint
- [ ] Webhook KHÔNG bị rate-limit/scope (đã top-level — phase 4)
- [ ] `paykit-service` + `paykit-server` suite xanh

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F4: `/v1/refunds` thiếu ownership check → refund tx merchant khác → drain balance | Med | **Critical** | Assert `txRow.tenantId==auth.tenantId`; test merchant-A-vs-B |
| F3: mint nhận body merchantId/scopes tùy ý → leo thang + cross-tenant key | Med | **Critical** | JWT/admin-only; merchantId từ auth; scopes ⊆ caller; negative tests |
| F7: "wrap" admin refund → adminContext undefined → NPE/audit rác hoặc 403 merchant | High | High | Extract guard-agnostic core; admin route cũ vẫn xanh |
| F8: rewrite route sang `OpenAPIHono` lan rộng / zod-v4.4.3 peer vỡ giữa phase | Med | High | Verify `@hono/zod-openapi` × zod-v4.4.3 TRƯỚC (blocking gate); incompatible → dừng + escalate, KHÔNG tự đổi lib |
| F13: DTO non-strict strip PAN âm thầm hoặc log raw → PCI breach | Med | Med | `zod.strict()` + negative test + redaction trên log |
| F14: in-memory rate-limit bị bypass multi-instance | High | Med (defer) | Mint dùng per-merchant DB-counted cap (durable — chốt V4.0); rate-limit chung in-memory chỉ soft throttle; document non-authoritative |
| DTO không khớp logic route cũ → SDK lệch | Med | Med | Contract test khóa shape; spec từ schema export |

## Security Considerations

- `/v1/api-keys` mint = endpoint nhạy cảm nhất: **JWT/admin plane ONLY** (F3, thực thi D1), merchantId từ auth, scopes ⊆ caller, plaintext 1 lần (phase 2).
- `/v1/refunds`: ownership check là bắt buộc (F4) — scope ≠ ownership.
- OpenAPI spec KHÔNG nhúng secret/key thật trong example.
- Rate-limit chỉ soft throttle (F14), KHÔNG thay WAF/DDoS.
- PCI (D8): `/v1/checkouts` trả redirect/token; `zod.strict()` chặn field PAN (F13).
- Khuyến nghị `/ck:security` threat-model mint + refund endpoint trước khi implement.

## Open questions
1. **F8:** ✅ RESOLVED (Validation S1) → `@hono/zod-openapi` (rewrite route). Verify zod-v4.4.3 peer-compat TRƯỚC khi commit dep (blocking gate; incompatible → escalate).
2. **F14:** ✅ RESOLVED (Validation S1) → mint endpoint THÊM per-merchant DB-counted cap ở V4.0 (durable, multi-instance-safe).
