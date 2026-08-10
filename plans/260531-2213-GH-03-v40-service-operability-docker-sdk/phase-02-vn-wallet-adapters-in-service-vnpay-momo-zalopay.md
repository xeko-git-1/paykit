---
phase: 2
title: "VN wallet adapters in service (VNPay/Momo/ZaloPay)"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 2: VN wallet adapters in service (VNPay/Momo/ZaloPay)

> **Red-team applied (2026-06-01):** F7 — Dockerfile 2 stage dùng `--frozen-lockfile`
> (`Dockerfile:25,74`); thêm 3 workspace dep mà không regenerate `pnpm-lock.yaml` → `docker
> compose build` fail `ERR_PNPM_OUTDATED_LOCKFILE`. Verified-OK: tên field 3 adapter VN khớp
> factory (`vnpay/momo/zalopay-adapter/src/adapter.ts`); webhook VN dùng `verifyWebhookSignature`
> (không phải `resolveWebhook`) — mount top-level OK.

## Overview

Service hiện chỉ wire 3/8 adapter (Stripe/SePay/NowPayments). "VN methods qua Docker" hiện chỉ
= SePay. Thêm 3 ví VN vào `config.ts` (env parse) + `adapters-from-env.ts` (lazy import) +
Dockerfile (copy package). Thuần config, không đụng core/ledger.

## Requirements

**Functional**
- `config.ts` parse env cho 3 provider (mỗi cái optional, enable khi đủ creds):
  - **VNPay:** `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_RETURN_URL`, `VNPAY_IPN_URL`,
    `VNPAY_ENVIRONMENT?` (sandbox|production).
  - **Momo:** `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`, `MOMO_SECRET_KEY`, `MOMO_RETURN_URL`,
    `MOMO_IPN_URL`, `MOMO_ENVIRONMENT?`.
  - **ZaloPay:** `ZALOPAY_APP_ID`, `ZALOPAY_KEY1`, `ZALOPAY_KEY2`, `ZALOPAY_RETURN_URL`,
    `ZALOPAY_CALLBACK_URL`, `ZALOPAY_ENVIRONMENT?`.
- `adapters-from-env.ts` lazy-import + push adapter khi creds đủ (mirror Stripe/SePay block).
- Dockerfile copy 3 package (builder + runtime stage).
- `package.json` service thêm 3 workspace dep.

**Non-functional**
- Adapter creds shape khớp factory interface đã verify:
  - `createVnpayAdapter(VnpayAdapterConfig)` — `tmnCode, hashSecret, returnUrl, ipnUrl, environment?`
  - `createMomoAdapter(MomoAdapterConfig)` — `partnerCode, accessKey, secretKey, returnUrl, ipnUrl, environment?`
  - `createZaloPayAdapter(ZaloPayAdapterConfig)` — `appId, key1, key2, returnUrl, callbackUrl, environment?`
- KISS: không thêm env cho field optional ít dùng (locale, orderType) ở V4.0 — adapter có default.

## Architecture

```
config.ts envSchema (zod) → thêm 3 optional block
   ServiceConfig.vnpay / .momo / .zalopay (undefined nếu thiếu creds)

adapters-from-env.ts
   if (config.vnpay)   adapters.push(createVnpayAdapter({...}))
   if (config.momo)    adapters.push(createMomoAdapter({...}))
   if (config.zalopay) adapters.push(createZaloPayAdapter({...}))

Dockerfile: COPY packages/{vnpay,momo,zalopay}-adapter (builder + runtime)
```

## Related Code Files

- **Modify:** `packages/service/src/config.ts` — thêm 3 env block + 3 field `ServiceConfig`
- **Modify:** `packages/service/src/adapters-from-env.ts` — 3 lazy-import block
- **Modify:** `packages/service/package.json` — `@xeko-git-1/paykit-vnpay`, `-momo`, `-zalopay` (workspace:*)
- **Modify:** `packages/service/Dockerfile` — **F6:** COPY 3 package.json + 3 dist, CẢ HAI stage
  (builder COPY package.json trước install + COPY src trước build; runtime COPY dist + package.json).
  Tổng = 6 COPY mới × phân bổ 2 stage.
- **F7:** regenerate + commit `pnpm-lock.yaml` sau khi thêm dep (gating cho docker build phase 3).
- **Modify (TEST):** `packages/service/__tests__/config-validation.test.ts` — thêm case 3 provider
- **Create (TEST FIRST):** `packages/service/__tests__/adapters-from-env-vn.test.ts`

## Implementation Steps (TDD)

1. **RED:**
   - `adapters-from-env-vn.test.ts`: env đủ VNPay → adapters chứa vnpay adapter (id match);
     thiếu 1 field → không push; cả 3 đủ → 3 adapter. Mock dynamic import hoặc assert length.
   - `config-validation.test.ts`: env 3 provider → `config.vnpay/.momo/.zalopay` defined; thiếu → undefined.
   Chạy → FAIL.
2. **GREEN:**
   - Thêm 3 env block vào `envSchema` + map sang `ServiceConfig` (mirror sepay block, kiểm tra
     đủ field bắt buộc mới set object).
   - Thêm 3 import block vào `buildAdaptersFromConfig`.
   - Cập nhật Dockerfile copy 3 package (builder COPY package.json trước install, COPY src
     trước build; runtime COPY dist + package.json).
   - Thêm 3 dep service `package.json`.
3. **VERIFY:** `pnpm install && pnpm --filter @xeko-git-1/paykit-service build && pnpm vitest run packages/service` → PASS.

## Success Criteria

- [x] Env đủ creds VNPay/Momo/ZaloPay → adapter tương ứng được wire
- [x] Thiếu field bất kỳ của 1 provider → provider đó không enable (không crash)
- [x] Dockerfile build chứa 3 package (verify ở phase 3 docker build)
- [x] `config-validation` + `adapters-from-env-vn` test xanh
- [x] Service giờ wire 6 adapter (Stripe/SePay/NowPayments + VNPay/Momo/ZaloPay)
- [x] **F6:** Dockerfile COPY đủ 3 package × 2 stage; **F7:** lockfile regenerated + committed

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Dockerfile quên copy 1 package → build fail / adapter missing runtime | Med | High | Phase 3 chạy `docker compose build` thật để verify; checklist 3 package |
| Field creds shape lệch (vd zalopay `callbackUrl` vs `ipnUrl`) | Med | Med | Đã verify từng interface (`adapter.ts`); test config map đúng tên field |
| Env phình to khó đọc | Low | Low | Group theo provider + comment; chấp nhận — KISS hơn config file |
| Webhook path VN provider chưa mount ở service | Med | Med | webhook top-level `/webhooks/*` đã mount qua `paykit.webhookRoutes()` (main.ts:64) — registry-driven, adapter tự thêm route. Verify ở phase 5 e2e |
