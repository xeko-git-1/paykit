---
phase: 1
title: "Schema and migration 012 (merchants + api_keys)"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Schema and migration 012 (merchants + api_keys)

> **Red-team applied (2026-05-29):** F1 (wrong manifest file + nonexistent checksum) →
> edit `packages/cli/migrations/manifest.json`, NOT `release-manifest.json`; runner has
> no checksum gate. F10 (down-migration data loss) → rename-not-drop on down.

## Overview

Nền dữ liệu cho auth: 2 bảng mới `paykit.merchants` (tenant gốc của service, thay
`TenantResolver`) và `paykit.api_keys` (key hashed, scope, rotation/revoke). Migration
**012** nối tiếp chuỗi hiện tại (cao nhất là 011 — `refund_pending_webhook`, đã commit). Drizzle schema + entry trong `migrations/manifest.json` (KHÔNG checksum — runner không có cơ chế đó).

## Requirements

**Functional**
- `merchants`: `merchant_id uuid PK`, `name text`, `status text default 'active'` (CHECK `active|suspended`), `created_at`, `updated_at`.
- `api_keys`: `key_id uuid PK`, `merchant_id uuid NOT NULL FK→merchants`, `key_hash text NOT NULL UNIQUE`, `key_prefix text NOT NULL` (vd `pk_live_Abc1` — 4 ký tự đầu để hiển thị, KHÔNG đủ để verify), `mode text` (CHECK `live|test`), `scopes text[] NOT NULL default '{}'`, `last_used_at timestamptz`, `revoked_at timestamptz`, `created_at`. **D2 (Validation S1):** `mode` là **label, KHÔNG tách data** ở V4.0 (cả live/test cùng ledger/tenant) — document rõ trong code comment + README service; KHÔNG enforce reject test key. Data-isolation thật defer V4.x.
- Index: `api_keys(key_hash)` (lookup verify), `api_keys(merchant_id)`.
- Migration 012 up + down. **Down KHÔNG `DROP TABLE`** (F10): rename `merchants`/`api_keys`
  → `*_quarantine_<reverted>` để rollback không hủy key đang sống. Re-apply 012 tạo bảng
  mới rỗng; bảng quarantine giữ data cũ cho re-promote thủ công.
- Manifest entry trong `packages/cli/migrations/manifest.json` (id `012`, slug, up, down,
  description) — **KHÔNG có field checksum**. Runner (`migration-runner.ts`) chỉ track theo
  `id` trong `schema_migrations` + advisory-lock; **không có cơ chế checksum** (F1).
  `release-manifest.json` ở root là file của ClaudeKit tooling — TUYỆT ĐỐI không đụng.

**Non-functional**
- Migration idempotent qua advisory-lock + `schema_migrations` (đã có trong runner).
- KHÔNG đụng bảng hiện tại; thuần additive.
- `merchant_id` đóng vai `tenantId` = `ownerId` cho V4.0 (D3) — KHÔNG thêm cột tenancy mới vào ledger.

## Architecture

```
paykit.merchants 1───* paykit.api_keys
   merchant_id  ◄──────  merchant_id (FK, ON DELETE RESTRICT)

api_keys.key_hash = sha256(plaintext)  ← verify lookup (UNIQUE + indexed)
api_keys.key_prefix = "pk_live_" + first4(random)  ← display only
```

Tenancy mapping (D3): request mang API key → middleware resolve `merchant_id` →
set `{tenantId: merchant_id, ownerId: merchant_id}` vào context. Ledger/payment rows
giữ nguyên 2 cột `tenant_id`/`owner_id` đang có.

## Related Code Files

- **Create:** `packages/cli/migrations/012_merchants_and_api_keys.up.sql`
- **Create:** `packages/cli/migrations/012_merchants_and_api_keys.down.sql` (rename-not-drop, F10)
- **Create:** `packages/server/src/db/schema/merchants.ts` (Drizzle, mirror `customers.ts` style)
- **Create:** `packages/server/src/db/schema/api-keys.ts`
- **Modify:** `packages/server/src/db/schema/index.ts` (export 2 schema mới)
- **Modify:** `packages/server/src/index.ts` (barrel re-export)
- **Modify:** `packages/cli/migrations/manifest.json` (append entry id `012`: id/slug/up/down/description — KHÔNG checksum). KHÔNG đụng `release-manifest.json`.
- **Create (TEST FIRST):** `packages/server/__tests__/v4-migrations-shape.test.ts`

## Implementation Steps (TDD)

1. **RED:** viết `v4-migrations-shape.test.ts` — assert: (a) file 012 up/down tồn tại; (b) up chứa `CREATE TABLE paykit.merchants` + `paykit.api_keys`, UNIQUE trên `key_hash`, FK `merchant_id`; (c) down **rename-not-drop** (chứa `ALTER TABLE ... RENAME TO ..._quarantine`, KHÔNG `DROP TABLE merchants`); (d) **F6 gap/order:** `manifest.json` có entry id `012` ở cuối, ids ascending + contiguous (001..012, không nhảy cóc); (e) `manifest.json` entry trỏ tới đúng tên file up/down. Mirror `v2-migrations-shape.test.ts`. Chạy → FAIL.
2. **GREEN:** viết 012 up/down SQL + 2 Drizzle schema files; export qua index barrels.
3. **Append entry `012` vào `packages/cli/migrations/manifest.json`** (id/slug/up/down/description — KHÔNG checksum, runner không có cơ chế đó). KHÔNG đụng `release-manifest.json`.
4. **VERIFY:** `pnpm --filter @xeko-git-1/paykit-server build && pnpm vitest run packages/server/__tests__/v4-migrations-shape.test.ts` → PASS.
5. (Tùy chọn) chạy migration thật trên Postgres test DB qua `paykit migrate` → bảng tạo, re-run no-op (idempotent); `listStatus` trả `012` pending→applied.

## Success Criteria

- [x] `v4-migrations-shape.test.ts` FAIL trên tree hiện tại, PASS sau khi thêm file
- [x] 012 up tạo `merchants` + `api_keys` với UNIQUE(key_hash), FK, indexes
- [x] 012 down **rename-not-drop** (rollback không hủy key đang sống — F10)
- [x] `manifest.json` có entry 012 (KHÔNG `release-manifest.json`); ids ascending contiguous (F6)
- [x] Drizzle schema export; `paykit-server` build xanh
- [x] `paykit migrate` apply 012, `schema_migrations` ghi id `012`; re-run no-op

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sửa nhầm `release-manifest.json` (CK tooling) → 012 không register, test xanh nhưng prod thiếu bảng | Med | **Critical** | F1: test assert entry trong `migrations/manifest.json`; runner chỉ đọc file này (`paykit.ts` MANIFEST_PATH) |
| Down `DROP TABLE` → rollback hủy key sống → mass 401 không recover | Med | High | F10: rename-not-drop; runbook re-promote từ `*_quarantine` |
| Manifest array order sai → `migrateDown` revert nhầm migration | Low | Med | F6: test ids ascending contiguous; 012 append cuối mảng |
| `merchant_id` = tenant gán cứng chặn sub-merchant sau này | Low | Med | D3 chấp nhận; mở rộng là migration mới khi có nhu cầu marketplace |
| `key_prefix` lộ quá nhiều ký tự → brute-force | Low | High | Chỉ lưu 4 ký tự display; verify luôn dùng full-hash, không dùng prefix |

## Security Considerations

- `key_hash` UNIQUE + indexed; KHÔNG lưu plaintext key ở bất kỳ cột nào.
- `key_prefix` chỉ để UI hiển thị (`pk_live_Abc1…`), không đủ verify.
- FK `ON DELETE RESTRICT` — không cho xóa merchant còn key sống (audit trail).
