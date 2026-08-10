---
phase: 4
title: "Thin TS SDK generated from OpenAPI"
status: completed
priority: P2
effort: "4h"
dependencies: [3]
---

# Phase 4: Thin TS SDK generated from OpenAPI

## Overview

"Dễ thêm vào app khác" — hiện consumer phải tự viết HTTP client tay. `/v1/openapi.json` đã serve
(phase 5 cũ). Thêm package `@xeko-git-1/paykit-sdk`: thin TS client generate từ OpenAPI spec, type-safe,
gắn `Authorization: Bearer pk_...` tự động. Một ngôn ngữ (TS) làm chuẩn; Python/Go/PHP defer.

> **Red-team applied (2026-06-01):** F4 (High) checkout DTO contract SAI — thật là
> `{amountUsd?, amountVnd?, provider, discountCode?}` `.strict()` (`dto.ts:19-24`), KHÔNG phải
> `{provider, amountMicros, currency}`. SePay = VND → `amountVnd`. F11 (Med) `/v1/openapi.json`
> served no-auth + gồm `mintApiKeyRoute` (`openapi.ts:81-93`) → `openapi-fetch` sinh client cho
> MỌI path → SDK sẽ expose mint trừ khi filter (trái D1: SDK là api_key plane, mint là jwt plane).
> F15 (Med) `openapi-fetch` thành runtime dep ship cho mọi integrator — phải pin-exact + vet;
> snapshot test cần devDep `@xeko-git-1/paykit-service`.

## Real /v1 contract (verified — SDK phải khớp)

| Endpoint | Request (`.strict()`) | Plane |
|---|---|---|
| `POST /v1/checkouts` | `{amountUsd?, amountVnd?, provider, discountCode?}` (`dto.ts:19-24`) | api_key |
| `GET /v1/balances` | query | api_key |
| `GET /v1/payments` | query | api_key |
| `POST /v1/refunds` | `{transactionId, amountMicros, ...}` (`dto.ts:87`) | api_key |
| `POST /v1/api-keys` | mint | **jwt — SDK KHÔNG expose (F11)** |

## Requirements

**Functional**
- Package mới `packages/sdk` (`@xeko-git-1/paykit-sdk`).
- Generate types + client từ `/v1/openapi.json` (committed snapshot, không fetch lúc build).
- Client API: `createPaykitClient({ baseUrl, apiKey })` → method-per-endpoint:
  `checkouts.create()`, `balances.get()`, `payments.list()`, `refunds.create()`.
- Tự gắn auth header; trả typed response; map error envelope `{error:{code,message}}` thành throw.
- Mint endpoint (`/v1/api-keys`) là JWT/admin plane — SDK api-key client KHÔNG expose mint (đúng D1).
  **F11:** `openapi.json` served gồm `mintApiKeyRoute` → generator sinh client cho mọi path →
  PHẢI filter `/v1/api-keys` khỏi spec snapshot HOẶC khỏi public client surface (không re-export
  method mint). Test assert SDK không có `apiKeys.create`.

**Non-functional**

<!-- Updated: Validation Session 1 — F15 chốt types-only + wrapper, bỏ nhánh openapi-fetch runtime -->

- **Generator (F15 — Validation S1 CHỐT):** **`openapi-typescript` (types-only) + wrapper transport
  tay (~50 dòng)**. KHÔNG dùng `openapi-fetch` runtime client → **không runtime dep** ship cho
  integrator (an toàn supply-chain cho payment SDK). `openapi-typescript` chỉ là devDep (sinh types
  lúc build, không vào bundle runtime).
  **Blocking gate:** verify `openapi-typescript` parse được OpenAPI 3.1 spec `@hono/zod-openapi`
  sinh ra TRƯỚC khi commit (3.1 vs 3.0 khác); incompatible → escalate.
- Wrapper transport tay: `fetch` chuẩn + gắn `Authorization` header + map error envelope. devDep
  `openapi-typescript` pin-exact; KHÔNG runtime dep.
- Spec snapshot commit vào repo (`packages/sdk/openapi.json`) + script regenerate; SDK không drift
  vì test so spec snapshot vs `/v1/openapi.json` runtime. **F15:** snapshot test ưu tiên so qua
  `buildServiceApp().request("/v1/openapi.json")` (bytes thật); devDep `@xeko-git-1/paykit-service`.
- KHÔNG tự build multi-lang; chỉ TS.

## Architecture

```
packages/sdk/
  openapi.json            ← snapshot từ GET /v1/openapi.json (committed)
  src/generated/          ← openapi-typescript output (types)
  src/client.ts           ← createPaykitClient (fetch wrapper + auth header, types từ generated)
  src/index.ts            ← public exports
  scripts/regenerate.ts   ← dump spec → regen types
  package.json

consumer:
  import { createPaykitClient } from "@xeko-git-1/paykit-sdk";
  const pk = createPaykitClient({ baseUrl, apiKey: "pk_live_..." });
  // F4: SePay = VND → amountVnd, KHÔNG amountMicros/currency
  const { url } = await pk.checkouts.create({ provider: "sepay", amountVnd: 50_000 });
```

## Related Code Files

- **Create:** `packages/sdk/package.json` (deps pin-exact — F15), `tsconfig.json`
- **Create:** `packages/sdk/src/client.ts`, `src/index.ts`
- **Create:** `packages/sdk/src/generated/*` (generated — types từ spec)
- **Create:** `packages/sdk/scripts/regenerate.ts` (dump `/v1/openapi.json` → openapi-typescript)
- **Create:** `packages/sdk/openapi.json` (committed snapshot — **F11:** mint path filtered out)
- **F15:** `packages/sdk/package.json` devDep `@xeko-git-1/paykit-service` (snapshot test) + regenerate lockfile
- **Create (TEST FIRST):** `packages/sdk/__tests__/client.test.ts` (mock fetch, assert auth header + typed call + error map + **không có `apiKeys.create` — F11**)
- **Create (TEST):** `packages/sdk/__tests__/spec-snapshot.test.ts` (so qua `buildServiceApp().request("/v1/openapi.json")` — F15)

## Implementation Steps (TDD)

1. **Verify generator peer-compat (BLOCKING GATE):**
   - Dump spec hiện tại: build service, gọi `getOpenAPIDocument()` (openapi.ts) → ghi `openapi.json`.
   - Thử `openapi-typescript` trên spec 3.1 → types compile. Incompatible → escalate, không tự đổi cách.
2. **RED:**
   - `client.test.ts`: mock fetch; `checkouts.create()` gửi `Authorization: Bearer <key>` +
     body đúng; response 2xx → typed; response `{error:{code,message}}` → throw có code.
   - `spec-snapshot.test.ts`: `openapi.json` snapshot === service `getOpenAPIDocument()` (chống drift).
   Chạy → FAIL.
3. **GREEN:**
   - Scaffold package; generate types (openapi-typescript devDep); viết `client.ts` (fetch wrapper
     tay gắn auth header, dùng generated types); map error; export. KHÔNG runtime dep.
   - `regenerate.ts` script + npm script `sdk:generate`.
4. **VERIFY:** `pnpm --filter @xeko-git-1/paykit-sdk build && pnpm vitest run packages/sdk` → PASS.

## Success Criteria

- [x] `createPaykitClient({baseUrl, apiKey})` gọi được 4 endpoint (checkouts/balances/payments/refunds), type-safe
- [x] **F4:** `checkouts.create` dùng đúng DTO `{amountUsd?|amountVnd?, provider, discountCode?}` `.strict()` — không `amountMicros/currency`
- [x] Auth header tự gắn; error envelope → throw có `code`
- [x] **F11:** SDK KHÔNG expose mint (no `apiKeys.create`); spec snapshot filtered mint path
- [x] spec snapshot test chống drift qua `buildServiceApp().request("/v1/openapi.json")` (F15)
- [x] **F15:** runtime dep pin-exact + vetted; service là devDep cho snapshot test; lockfile committed
- [x] `paykit-sdk` build + test xanh; generator peer-compat OpenAPI 3.1 verified

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F4: SDK gửi DTO sai → checkout 400 (strict reject) | High | High | Lock đúng contract `dto.ts:19-24`; client.test gửi amountVnd cho SePay |
| F11: generator sinh mint client → SDK lộ jwt-plane endpoint | Med | Med | Filter mint path khỏi snapshot; assert no `apiKeys.create` |
| OpenAPI 3.1 generator chưa hỗ trợ đầy đủ → types vỡ | Med | High | Blocking gate verify trước thêm dep; fallback types-only + wrapper tay |
| F15: runtime dep không pin → supply-chain trong payment SDK | Med | Med | Pin-exact; ưu tiên types-only; vet trước thêm |
| Spec drift: SDK cũ vs `/v1` mới | Med | Med | snapshot test so bytes runtime; regenerate script |
| SDK ôm thêm logic business → fat client | Low | Med | Thin: chỉ transport + auth + types; logic ở service |
| Maintenance multi-lang phình | Low (defer) | — | V4.0 chỉ TS; Python/Go defer tới khi có nhu cầu thật |
