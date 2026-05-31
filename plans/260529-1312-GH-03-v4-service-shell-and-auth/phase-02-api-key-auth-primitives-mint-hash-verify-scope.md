---
phase: 2
title: "API-key auth primitives — mint/hash/verify/scope"
status: pending
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 2: API-key auth primitives — mint/hash/verify/scope

> **Red-team applied (2026-05-29):** F3 → mint primitive nhận `merchantId`+`scopes` tùy ý
> là CHỦ Ý (primitive thuần); ràng buộc "minted-scopes ⊆ caller-scopes" + "merchantId từ
> caller, không từ body" thực thi ở **endpoint layer (phase 5)**. Phase 2 thêm helper
> `isScopeSubset(child, parent)` để phase 5 gọi. F-reject: sha256-no-salt giữ nguyên
> (rationale đúng cho high-entropy key — reviewer xác nhận).

## Overview

Logic thuần (no HTTP, no Hono) cho vòng đời API key: **mint** (sinh key + prefix + hash),
**hash** (sha256), **verify** (timing-safe lookup theo hash), **scope check**. Đây là unit
cô lập — TDD dễ, là tầng bảo mật cốt lõi nên test trước khi ghép middleware (phase 3).

## Requirements

**Functional**
- `mintApiKey(opts: { merchantId, mode: 'live'|'test', scopes })` → `{ plaintext, keyPrefix, keyHash, record }`. `plaintext` = `pk_{mode}_{base62(32 bytes random)}`. Trả plaintext **một lần duy nhất** (caller lưu vào DB qua repo, KHÔNG lưu plaintext).
- `hashApiKey(plaintext)` → sha256 hex. Pure, deterministic.
- `verifyApiKey(plaintext, lookup)` → `{ ok, record }`. Lookup = hàm `(keyHash) => ApiKeyRecord | null` (repo inject). Reject nếu: không tìm thấy, `revoked_at != null`. Timing-safe compare khi so khớp.
- `hasScope(record, required)` → boolean. `scopes` rỗng = no permission (deny-by-default, KHÔNG phải allow-all).
- `isScopeSubset(child, parent)` → boolean (F3): true nếu mọi scope trong `child` ⊆ `parent`. Phase 5 dùng để chặn mint key tự nâng quyền.
- Repo: `api-key.repo.ts` — `findByHash`, `insert`, `markRevoked`, `touchLastUsed`.

**Non-functional**
- Zero new runtime deps nếu được (dùng `node:crypto` `randomBytes`/`createHash`/`timingSafeEqual`).
- Module < 200 dòng; tách `mint`/`verify`/`scope` nếu cần (kebab-case).
- KHÔNG log plaintext/hash ở bất kỳ path nào.

## Architecture

```
mintApiKey ──► plaintext (return once) ──► caller persists via repo.insert(keyHash,...)
                    │
              hashApiKey(sha256)
                    │
request key ──► hashApiKey ──► repo.findByHash ──► verifyApiKey
                                                       │ ok?
                                                       ├─ revoked? → deny
                                                       └─ hasScope(required)? → allow/deny
                              (async) repo.touchLastUsed(key_id)  ← non-blocking audit
```

Deny-by-default: scope không khớp → 403; key không tồn tại/revoked → 401.

## Related Code Files

- **Create:** `packages/server/src/auth/api-key.ts` (mint + hash + verify)
- **Create:** `packages/server/src/auth/scope.ts` (`hasScope`, scope constants vd `checkout:write`, `balance:read`)
- **Create:** `packages/server/src/db/repos/api-key.repo.ts`
- **Modify:** `packages/server/src/index.ts` (export auth primitives + repo cho service shell dùng)
- **Create (TEST FIRST):** `packages/server/__tests__/api-key-auth-primitives.test.ts`

## Implementation Steps (TDD)

1. **RED:** `api-key-auth-primitives.test.ts` — cover:
   - mint sinh `pk_live_`/`pk_test_` đúng prefix, plaintext ≥ entropy ngưỡng, `keyHash === hashApiKey(plaintext)`.
   - verify: key đúng + active → ok; revoked → deny; hash sai → deny.
   - `hasScope`: required ∈ scopes → true; scopes rỗng → false (deny-by-default); wildcard nếu thiết kế (quyết định: KHÔNG wildcard cho V4.0, KISS).
   - timing-safe: verify dùng `timingSafeEqual` (assert qua không so sánh `===` chuỗi — review-level, hoặc test hành vi reject).
   Chạy → FAIL.
2. **GREEN:** implement `api-key.ts` + `scope.ts` + repo (repo unit test dùng fake DB theo pattern `admin-routes.test.ts`).
3. **VERIFY:** `pnpm --filter @vibecc/paykit-server build && pnpm vitest run packages/server/__tests__/api-key-auth-primitives.test.ts` → PASS.

## Success Criteria

- [ ] Test FAIL trước, PASS sau implement
- [ ] mint→hash→verify round-trip đúng; revoked key bị từ chối
- [ ] `hasScope` deny-by-default (scopes rỗng = no access)
- [ ] verify dùng timing-safe compare; không log secret
- [ ] Build xanh; module < 200 dòng/file

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| sha256 plain (không salt) bị rainbow-table | Low | Med | Key có entropy cao (32 bytes random) → rainbow-table bất khả thi; salt không cần cho high-entropy secret (khác password). Tài liệu hóa rationale |
| Scope model quá đơn giản, sau khó mở | Low | Low | Scope = string[] linh hoạt; thêm scope mới là additive |
| Timing attack trên verify | Low | Med | `timingSafeEqual`; lookup bằng hash (DB index) không leak qua thời gian |

## Security Considerations

- **KHÔNG salt-per-key** là chủ ý: API key entropy cao (≠ password người dùng yếu) → sha256 đủ; tránh phức tạp bcrypt/argon2 cho high-throughput verify path. Ghi rõ comment why (invariant, không tham chiếu phase).
- Plaintext trả về **đúng 1 lần** lúc mint; không có đường đọc lại.
- `touchLastUsed` async, không chặn request; lỗi touch không fail auth.
