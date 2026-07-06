---
phase: 3
title: "Auth middleware — API-key + JWT planes replacing TenantResolver"
status: completed
priority: P1
effort: "5h"
dependencies: [2]
---

# Phase 3: Auth middleware — API-key + JWT planes replacing TenantResolver

> **Red-team applied (2026-05-29):** F5 (dual-source fail-open) → service-mode resolver
> phải fail-CLOSED (throw); `/v1` không có `paykitAuth` = 401, không fallback header.
> F6 (JWT hardening) → pin `algorithms:['HS256']`, reject `alg:none`/HS-RS confusion,
> require `iss`+`aud`, secret ≥32 bytes. F9 (fake-DB test vô giá trị) → characterization
> test phải assert repo mock gọi đúng `tenantId`, hoặc chạy real-Postgres 2-tenant.
> F11 → Modify-list phải gồm `subscriptions/tenant-routes.ts` + `idempotency-middleware.ts`.

> **Validation Session 1 (2026-05-29):** D6 → JWT secret đọc từ DB `runtime_config`
> (migration 008), KHÔNG env `PAYKIT_JWT_SECRET`. F11 → subscriptions **scope OUT V4.0**
> (chỉ embedded mode); KHÔNG migrate 2 file subscription routes ở phase này.

## Overview

Điểm refactor rủi ro nhất: ghép primitives (phase 2) thành **Hono middleware** thay
nguồn tenant từ `TenantResolver(req)` sang **API key → merchant**. Hai plane tách cứng:
API-key (server↔server, mọi `/v1` route) và JWT (dashboard/frontend, scope hẹp). TDD lock
hành vi tenant-scoping hiện có TRƯỚC khi đổi nguồn.

## Requirements

**Functional**
- `apiKeyAuthMiddleware(deps)`: đọc `Authorization: Bearer pk_...` → hash → `repo.findByHash` → verify → set `c.set('paykitAuth', { merchantId, tenant: {tenantId, ownerId}, scopes, plane: 'api_key' })`. 401 nếu thiếu/sai/revoked. Mirror `adminGuardMiddleware` shape (`admin-guard.ts`).
- `jwtAuthMiddleware(deps)`: verify JWT, set `paykitAuth` với `plane: 'jwt'`. 401 nếu invalid/expired. **F6 hardening (bắt buộc):** chọn lib cụ thể (`hono/jwt` hoặc `jose` — chốt 1, KHÔNG để mơ hồ); pin `algorithms: ['HS256']`; reject `alg:none` + bất kỳ token non-HS256 (chống HS/RS confusion); require claim `iss` + `aud` khớp giá trị paykit. **D6 (Validation S1): secret đọc từ DB `runtime_config`** (migration 008 đã có), KHÔNG từ env `PAYKIT_JWT_SECRET`. Bootstrap generate + seed secret ≥32 bytes vào `runtime_config` nếu vắng; verify ≥32 bytes khi load; rotation qua DB (update row). Middleware nhận secret-loader inject (đọc + cache từ runtime_config).
- `requireScope(scope)`: middleware con, 403 nếu `paykitAuth.scopes` thiếu scope (dùng `hasScope` phase 2).
- **Plane separation (D1):** route `/v1/*` server-to-server CHỈ chấp nhận api_key plane; route dashboard/frontend CHỈ chấp nhận jwt plane. Middleware reject sai-plane bằng 401 (không leak lý do chi tiết). `requireScope` thêm assert `plane` khi route yêu cầu (vd mint key = jwt-only).
- **Tenant bridge:** route handlers hiện đọc tenant qua `tenantResolver(c.req.raw)` → đổi sang đọc `c.get('paykitAuth').tenant`. Tạo adapter `authTenant(c): ResolvedTenant`. **F5 fail-CLOSED:** trên `/v1` route, nếu `paykitAuth` vắng mặt → 401 NGAY, KHÔNG fallback `tenantResolver`. Service shell (phase 4) inject một resolver **throw** `TenantResolutionError` để mọi fallback ngoài ý muốn cũng 401, không bao giờ resolve tenant từ header do caller kiểm soát.

**Non-functional**
- KHÔNG xóa `TenantResolver` khỏi server library (backward-compat embedded mode — xem plan §Cross-cutting). Service shell (phase 4) wire middleware; embedded consumer vẫn dùng resolver cũ.
- Lỗi guard → 500 message an toàn, KHÔNG leak stack (theo `admin-guard.ts:23`).

## Architecture

```
            ┌─ /v1/* (server↔server) ──► apiKeyAuthMiddleware ──┐
 request ───┤                                                    ├─► c.set('paykitAuth')
            └─ /dashboard/* (frontend) ─► jwtAuthMiddleware ─────┘        │
                                                                          ▼
                                          requireScope('checkout:write')  │
                                                                          ▼
                            route handler: authTenant(c) → {tenantId, ownerId}
                                          (thay tenantResolver(c.req.raw))

 PLANE GUARD: api_key plane ❌ trên dashboard route; jwt plane ❌ trên /v1 route → 401
```

Embedded mode (giữ nguyên): `createPaykit({ tenantResolver })` → route đọc resolver.
Service mode (mới): middleware set `paykitAuth` → route đọc `authTenant(c)`.
→ **F5 fail-CLOSED:** handler ưu tiên `paykitAuth`; trên `/v1` (service mode) nếu vắng
`paykitAuth` → 401, KHÔNG fallback. Service shell inject resolver throw, nên embedded
fallback chỉ sống ở embedded mode (consumer tự inject resolver thật), service mode
không bao giờ resolve tenant từ request do caller kiểm soát.

## Related Code Files

- **Create:** `packages/server/src/auth/api-key-middleware.ts`
- **Create:** `packages/server/src/auth/jwt-middleware.ts`
- **Create:** `packages/server/src/auth/auth-context.ts` (`paykitAuth` type + `authTenant(c)` + Hono `ContextVariableMap` augmentation, theo `admin-guard.ts` declare-module)
- **Create:** `packages/server/src/auth/require-scope.ts`
- **Modify:** `packages/server/src/server/create-paykit.ts` — **F2: làm `tenantResolver` OPTIONAL** trên `PaykitConfig` + mọi route-builder dep, invariant "đúng một trong {tenantResolver, apiKey-auth} được wire". Đây là interface change **backward-compatible** (optional thêm vào), KHÔNG phá embedded consumer hiện có. Ghi rõ trong plan §Cross-cutting.
- **Modify:** `packages/server/src/routes/checkout/checkout-router.ts` + `stripe-route.ts` + `sepay-route.ts` (tenant từ `authTenant(c)`, fail-closed nếu service mode + vắng paykitAuth)
- **Modify:** `packages/server/src/routes/billing/{balance,ledger,payment-history}-route.ts` (cùng pattern)
- **F11 (Validation S1 — SCOPE OUT):** subscription routes (`subscriptions/tenant-routes.ts` + `idempotency-middleware.ts`) **KHÔNG migrate** sang service mode ở V4.0. Document "subscriptions = embedded mode only" (consumer tự inject `tenantResolver`). Service mode V4.0 chỉ phục vụ checkout/balance/ledger/history + `/v1`. Subscriptions-over-service defer V4.x.
- **Modify:** `packages/server/src/index.ts` (export middleware + auth-context)
- **Create (TEST FIRST):** `packages/server/__tests__/auth-middleware.test.ts`, `packages/server/__tests__/tenant-scoping-regression.test.ts`

## Implementation Steps (TDD)

1. **RED — lock hành vi cũ trước (F9 — phải đủ mạnh):** `tenant-scoping-regression.test.ts` — scope thực thi trong repo SQL (`listBalancesByTenant(db, tenant.tenantId)` — `balance-route.ts:38`), nên fake-DB chỉ trả canned rows. Test PHẢI assert **repo mock được gọi với đúng `tenantId`** đã auth (`expect(listBalancesByTenant).toHaveBeenCalledWith(db, expectedTenantId)`) cho CẢ resolver path lẫn paykitAuth path — KHÔNG chỉ assert HTTP 200 + shape (vô giá trị). **Hoặc** chạy 1 test này trên real-Postgres seed 2 tenant, assert key tenant A không đọc được balance tenant B. Phải PASS trên tree hiện tại (khóa hành vi).
2. **RED — auth mới:** `auth-middleware.test.ts`:
   - api-key: thiếu header → 401; key revoked → 401; key hợp lệ → set `paykitAuth.tenant`, next chạy.
   - jwt: token expired → 401; **F6: `alg:none` → 401; token ký non-HS256 → 401; thiếu `iss`/`aud` → 401**; **D6: secret từ `runtime_config` < 32 bytes (hoặc vắng + không seed được) → boot fail**; hợp lệ → plane jwt.
   - plane separation: api_key token trên dashboard route → 401; jwt trên `/v1` → 401.
   - **F5 fail-closed:** `/v1` request không set `paykitAuth` (resolver throw) → 401, KHÔNG resolve tenant từ header.
   - `requireScope`: thiếu scope → 403.
   Chạy → FAIL.
3. **GREEN:** làm `tenantResolver` optional (F2); implement 4 file auth/* (jwt-middleware đọc secret từ `runtime_config` — D6); augment route handlers checkout/balance/ledger/history (KHÔNG subscriptions — F11 scope OUT). Chạy LẠI `tenant-scoping-regression.test.ts` → vẫn PASS (không hồi quy embedded), VÀ assert tenantId truyền đúng.
4. **VERIFY:** `pnpm --filter @vibecc/paykit-server build && pnpm vitest run packages/server` → tất cả PASS gồm full suite.

## Success Criteria

- [x] Characterization test assert **repo gọi đúng `tenantId`** (không chỉ 200) — F9 proof thật
- [x] api-key middleware: 401 thiếu/sai/revoked; set tenant đúng khi hợp lệ
- [x] jwt middleware (F6): 401 cho expired/`alg:none`/non-HS256/thiếu iss-aud; **D6: secret từ `runtime_config`, boot fail nếu < 32 bytes / không seed được**
- [x] Plane separation enforced: sai-plane → 401
- [x] **F5:** `/v1` vắng `paykitAuth` → 401, KHÔNG fallback header
- [x] **F2:** `createPaykit` không `tenantResolver` (service mode) compile + resolve qua `authTenant(c)`; embedded mode (có resolver) vẫn xanh
- [x] **F11:** subscription routes documented OUT of service-mode V4.0 (embedded only)
- [x] Full `paykit-server` test suite xanh

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Refactor tenant nguồn → hồi quy scope (credit nhầm tenant) | Med | **Critical** | F9: characterization test assert tenantId truyền đúng (không chỉ 200); cân nhắc real-Postgres 2-tenant |
| F5 fallback fail-OPEN → unauth đọc/credit tenant khác qua header | Med | **Critical** | Service shell inject resolver THROW; `/v1` vắng paykitAuth → 401; test explicit |
| F2 `tenantResolver` required → service mode không compile / phải stub bẩn | High | High | Làm field optional (backward-compat); test cả 2 mode |
| F6 JWT alg confusion / weak secret → forge token bypass | Med | High | Pin HS256, reject none/non-HS256, require iss/aud, secret ≥32B |
| Plane confusion (jwt trên /v1) → leo thang quyền | Low | High | Test plane-separation explicit; middleware reject sai-plane |
| F11 subscriptions dùng resolver bị bỏ sót → service-mode subs vỡ | Med | Med | Modify-list gồm 2 file subs, hoặc scope OUT + document |
| Webhook route vô tình bị gắn auth (provider không gửi key) | Med | High | Webhook KHÔNG dùng resolver (`sepay-handler.ts:7`); KHÔNG mount auth lên `/webhooks/*` (xem phase 4 F2) |

## Security Considerations

- **Webhook routes tuyệt đối KHÔNG gắn auth middleware** — tenancy webhook đến từ locked
  `payment_transactions` row, không từ caller. Gắn nhầm = provider IPN bị 401, mất tiền.
- Plane separation là ranh giới leo thang quyền — test là bắt buộc, không optional.
- Khuyến nghị `/ck:security` threat-model phase này trước khi implement.
