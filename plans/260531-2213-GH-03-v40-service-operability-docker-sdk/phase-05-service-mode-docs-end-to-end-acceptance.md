---
phase: 5
title: "Service-mode docs + end-to-end acceptance"
status: completed
priority: P2
effort: "3h"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Service-mode docs + end-to-end acceptance

> **Red-team applied (2026-06-01):** F4 (High) checkout DTO đúng = `{amountVnd}` cho SePay (VND),
> KHÔNG `{amountMicros, currency}` (`dto.ts:19-24`). F6 (High) **13 bảng** không phải 12/5
> (thiếu `reconciliation_runs`). F14 (Med) `ci.yml` không có Postgres/Docker → e2e cold-start
> không gate được trong CI → thêm CI job `services: postgres:16`.

## Overview

Đóng last-mile: docs service-mode (Docker + bootstrap + SDK) — hiện `installation.md` chỉ có V3
embedded. Sửa số liệu drift (**5 → 13** tables) và viết acceptance test e2e phủ luồng cold-start →
bootstrap → mint → checkout qua service, chứng minh "drop vào app khác + config qua Docker" chạy thật.

## Requirements

**Functional**
- `docs/service-mode-setup.md` (mới): chạy bằng Docker, env reference (6 adapter + admin),
  bootstrap (`merchant create` + `apikey mint` + `jwt mint`), gọi `/v1` bằng curl + SDK.
- Sửa `docs/installation.md`: "5 tables" → đúng **13**; thêm link sang service-mode.
- `docs/v4-acceptance-tests.md` (mới): checklist e2e cold-start.
- E2E test: cold-start → bootstrap → mint → `/v1/checkouts` (SePay = `amountVnd`) → 2xx + DTO khớp.
- **F14:** thêm CI job `services: postgres:16` chạy migrate up + `buildServiceApp` + `/readyz` smoke.

**Non-functional**
- Docs trong `docs/` (≤800 LoC mỗi file).
- E2E ưu tiên real-Postgres (docker-compose hoặc testcontainer); CI job Postgres (F14) gate
  migrate→serve→/readyz; e2e Docker-full nếu CI không có Docker thì skippable-by-env + manual doc.
- Không trùng lặp: service-mode docs link tới refund-flows/sandbox-setup hiện có, không copy.

## Architecture

```
docs/
  installation.md          (sửa: 5→13 tables, thêm "Service mode →")
  service-mode-setup.md     (mới: Docker + bootstrap + /v1 + SDK)
  v4-acceptance-tests.md     (mới: e2e checklist)

.github/workflows/ci.yml    (F14: thêm job services: postgres:16 → migrate + /readyz smoke)

e2e/
  service-cold-start.e2e.ts  (mới): compose up sạch → migrate → bootstrap CLI →
    mint key → createPaykitClient → checkouts.create({provider:"sepay", amountVnd}) → assert 2xx + shape
```

## Related Code Files

- **Create:** `docs/service-mode-setup.md`
- **Create:** `docs/v4-acceptance-tests.md`
- **Modify:** `docs/installation.md` — fix table count **5→13** (line ~57, ~135 doctor output) + link service mode
- **Modify:** `README.md` — thêm dòng "Service mode (V4)" vào Architecture/Quickstart
- **Modify:** `.github/workflows/ci.yml` — **F14:** job `services: postgres:16` (migrate + smoke)
- **Create (TEST):** `e2e/service-cold-start.e2e.ts` (hoặc dưới `packages/service/__tests__/` nếu testcontainer)

## Implementation Steps

1. **E2E test (TDD nếu hạ tầng cho phép):**
   - Spin Postgres (testcontainer/compose) → `migrate up` → `merchant create` → `apikey mint`
     (scopes `checkout:write,payments:read`) → `buildServiceApp` (hoặc compose up) →
     SDK `checkouts.create({provider:"sepay", amountVnd: 50_000})` (F4) → assert 2xx + DTO.
   - Negative: key thiếu scope → 403; no key → 401.
2. **CI gate (F14):**
   - Thêm job `services: postgres:16` vào `ci.yml`: migrate up → `buildServiceApp` →
     `/readyz` 200 smoke (no daemon). Gate cold-start path ở CI, không chỉ manual.
3. **Docs:**
   - `service-mode-setup.md`: prerequisites (Docker), `docker compose up`, env table (6 provider +
     `ADMIN_SECRET`), bootstrap steps (CLI 3 command), curl examples `/v1/checkouts|balances|payments|refunds`,
     SDK quickstart, link OpenAPI `/v1/openapi.json`, runbook migrate-recovery (F13 từ phase 3).
   - Fix `installation.md` table count **5→13** + doctor expected output.
   - `v4-acceptance-tests.md`: checklist tương ứng Success Criteria.
4. **VERIFY:** chạy e2e + CI job (hoặc thủ công theo checklist) → toàn luồng xanh; `pnpm test` không hồi quy.

## Success Criteria

- [ ] `docs/service-mode-setup.md` đủ để 1 dev lạ deploy service qua Docker + gọi `/v1` thành công
- [ ] **F6:** `installation.md` không còn "5 tables" → **13**; có link service mode
- [ ] **F4:** E2E cold-start → bootstrap → mint → checkout (SePay `amountVnd`) → 2xx + DTO khớp
- [ ] E2E negative: thiếu scope → 403, no key → 401
- [ ] **F14:** CI job Postgres gate migrate→/readyz; cold-start không chỉ verify thủ công
- [ ] `pnpm test` toàn repo xanh (không hồi quy)
- [ ] README phản ánh service mode V4

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| F14: CI không gate cold-start → F1/F2 tái phát nhưng test vẫn xanh | High | High | Thêm CI job `services: postgres:16` migrate+smoke; "733 test pass" không đủ cho operability |
| F4: e2e gửi DTO sai → false fail / che lỗi thật | High | High | Dùng đúng `amountVnd` cho SePay; lock theo `dto.ts` |
| Docs drift tiếp sau khi code đổi | Med | Med | v4-acceptance-tests.md = checklist sống; gắn Success Criteria |
| E2E checkout cần creds thật (SePay sandbox) | Med | Med | Provider có sandbox; hoặc stub adapter cho HTTP-contract, creds thật để manual |
| E2E Docker-full không chạy trong CI | Med | Med | CI job Postgres (F14) cover migrate+smoke; Docker-full skippable + manual doc |
| Trùng nội dung docs sandbox-setup hiện có | Low | Low | Link thay vì copy |
