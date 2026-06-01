---
phase: 2
title: "Auth wiring + contract fixes"
status: pending
priority: P1
effort: "4-5h"
dependencies: []
---

# Phase 2: Auth wiring + contract fixes

> **User chốt (2026-05-31):** mint bootstrap = **CLI seed** (KHÔNG wire JWT plane ở V4.0; dashboard/JWT defer V4.4). → endpoint HTTP `/v1/api-keys` (jwt-only) là **dead-by-design có document**, không phải dead âm thầm.

## Overview

Sửa các wiring/contract gap khiến code chạy khác contract: mint endpoint không reachable
(JWT plane chưa mount), `/v1/openapi.json` lọt sau auth glob (trái "public"), rate-limit
khóa sai field, OpenAPI thiếu header/security scheme. Thêm CLI để tạo merchant + mint key
đầu tiên (giải chicken-and-egg).

## Requirements

**Functional**
- **CLI bootstrap (Q2):** `paykit merchant:create --name <n>` → insert merchants row, in `merchant_id`.
  `paykit key:mint --merchant <id> --mode <live|test> --scopes a,b` → gọi `mintApiKey` +
  `apiKeyRepo.insert`, in plaintext **1 lần**. Đây là trust boundary V4.0 (operator có DB access).
- **Gỡ dead JWT loader:** `buildServiceApp` destructure `jwtSecretLoader` (`main.ts:47`) rồi không dùng →
  gỡ khỏi deps + `main.ts:162-181`; gỡ `config.ts:bootstrapJwtSecret` trùng lặp (dead+duplicate).
  Document `/v1/api-keys` HTTP = "requires JWT plane — enabled in V4.4 dashboard".
- **`/v1/openapi.json` public (I2):** mount route TRƯỚC `app.use('/v1/*', apiKeyAuthMiddleware)`
  (giống `/healthz`), hoặc tách khỏi glob → trả spec không cần key. Sửa comment cho khớp.
- **OpenAPI completeness (I4):** thêm `Idempotency-Key` header param vào `POST /v1/refunds` route def;
  thêm `components.securitySchemes` (bearer) + `security` để SDK biết cần auth.
- **Error envelope (I6, M4):** thêm `app.onError` phát `{error:{code,message}}` (KHÔNG leak stack);
  error envelope include `apiVersion` cho khớp success body.

**Non-functional**
- KHÔNG bật JWT plane (giữ scope V4.0). Endpoint mint + test F3 giữ nguyên (đã đúng) — chỉ unreachable tới V4.4.

## Open question (cần user xác nhận trong phase)

- **Rate-limit semantics (I3):** code khóa theo `auth.merchantId` (`rate-limit.ts:74`) nhưng
  comment/contract nói "per key_id"; `PaykitAuthContext` thiếu `keyId`. **Đề xuất:** thêm `keyId`
  vào auth context (api-key-middleware set) + khóa bucket theo `keyId` → khớp contract. Nếu user
  muốn giữ per-merchant thì chỉ sửa comment. **Không tự quyết** — hỏi trước khi đổi.

## Related Code Files

- **Create:** `packages/cli/src/commands/merchant-create.ts`, `packages/cli/src/commands/key-mint.ts` (+ wire vào `bin/paykit.ts` dispatch)
- **Modify:** `packages/service/src/main.ts` (gỡ jwtSecretLoader; mount openapi trước glob; thêm onError)
- **Modify:** `packages/service/src/config.ts` (gỡ `bootstrapJwtSecret` dead code)
- **Modify:** `packages/service/src/v1/openapi.ts` (Idempotency-Key header + securitySchemes)
- **Modify (nếu chọn per-key):** `packages/server/src/auth/auth-context.ts` (+`keyId`), `api-key-middleware.ts` (set keyId), `packages/service/src/v1/rate-limit.ts` (khóa theo keyId)
- **Modify:** `packages/service/src/v1/response.ts` (apiVersion trong error envelope)
- **Create (TEST FIRST):** `packages/service/__tests__/openapi-public-access.test.ts` (qua `buildServiceApp` thật, KHÔNG harness riêng), CLI command test

## Implementation Steps (TDD)

1. **RED:**
   - `openapi-public-access.test.ts`: `GET /v1/openapi.json` qua app thật (có mount auth) → **200 không cần key**; spec có `securitySchemes` + refund route có `Idempotency-Key` param.
   - onError test: route ném → trả `{error:{code,message,...}}` + `apiVersion`, KHÔNG stack.
   - CLI test: `key:mint` → row trong DB, plaintext verify được qua `verifyApiKey`.
   - (nếu per-key) rate-limit test: 2 key CÙNG merchant → bucket độc lập.
   Chạy → FAIL.
2. **GREEN:** thực thi theo Requirements; gỡ dead loader; mount openapi trước glob; CLI commands.
3. **VERIFY:** `pnpm --filter @vibecc/paykit-service build && pnpm --filter @vibecc/paykit-cli build && pnpm vitest run packages/service packages/cli` → PASS.

## Success Criteria

- [ ] `/v1/openapi.json` trả 200 không cần key (qua app thật); có securitySchemes + Idempotency-Key param
- [ ] CLI `merchant:create` + `key:mint` tạo merchant/key, in plaintext 1 lần
- [ ] jwtSecretLoader chết + bootstrapJwtSecret trùng lặp đã gỡ; `/v1/api-keys` documented JWT-gated V4.4
- [ ] `app.onError` envelope + apiVersion; không leak stack
- [ ] Rate-limit khóa khớp contract (per-key sau khi user chốt, hoặc comment sửa nếu giữ per-merchant)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mount openapi trước glob vô tình để lọt route khác | Low | Med | Chỉ mount đúng path `/v1/openapi.json`; test các `/v1/*` khác vẫn 401 |
| Gỡ jwtSecretLoader phá test config-validation đang phủ nó | Med | Low | Test đang phủ code path không chạy thật → cập nhật/xóa test cho khớp; document |
| CLI mint bỏ qua scope-subset (CLI = full-trust) | Low | Med | CLI là operator-trust (DB access); document rõ CLI không áp scope-subset như HTTP mint |
| Đổi rate-limit sang keyId phá isolation hiện có | Low | Low | Test 2-key-same-merchant; chỉ đổi khi user chốt |
