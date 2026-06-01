---
phase: 6
title: "Extract @vibecc/paykit-auth-core (decouple CLI from server HTTP layer)"
status: pending
priority: P2
effort: "varies — refactor only, no new behavior"
dependencies: [1]
---

# Phase 6: Extract @vibecc/paykit-auth-core

> **Why this exists (deferred from Phase 1):** Phase 1 (F5) had the CLI bootstrap
> reuse server auth primitives + repos (`mintApiKey`, `SCOPES`,
> `MAX_ACTIVE_KEYS_PER_MERCHANT`, merchant/api-key/runtime-config repos,
> `createJwtSecretLoader`, `mintAdminJwt`) so the operator path enforces the SAME
> invariants as the HTTP mint route. That import (`cli → @vibecc/paykit-server`)
> violates the checked-in boundary rule in `packages/core/__tests__/no-cross-imports.test.ts`
> ("CLI must not bundle the HTTP layer"). User decision (2026-06-01): keep the
> reuse (DRY > duplication, avoids cap/scope drift) but resolve it cleanly by
> extracting a lower-tier package both CLI and server import — NOT by relaxing
> the rule permanently. The boundary test is currently `it.skip`-ped with a
> pointer here.

## Overview

Create `@vibecc/paykit-auth-core`: a dependency-light package holding the DB
schema, Drizzle client types, repos, and auth primitives that have NO HTTP/Hono
dependency. `server` re-exports from it (back-compat for all existing importers);
`cli` imports from it directly (no longer from `server`). Pure refactor — zero
behavior change, all existing tests must stay green.

## Measured coupling (scouted 2026-06-01)

- `paykitSchema` is defined in `db/schema/payment-transactions.ts` and imported by
  **15 schema files** — the schema layer moves as a unit (cannot split 3 tables).
- CLI needs **3 repos** (`merchant`, `api-key`, `runtime-config`) which depend on
  the schema + `db/client.ts` (`DbClient`/`DbOrTx`).
- Auth primitives CLI needs: `auth/api-key.ts` (`mintApiKey`, `MAX_ACTIVE_KEYS_PER_MERCHANT`),
  `auth/scope.ts` (`SCOPES`, `isScopeSubset`), `auth/jwt-claims.ts`, `auth/mint-admin-jwt.ts`
  (imports `hono/jwt` `sign` — **NOTE:** this one pulls hono; either keep `mint-admin-jwt`
  in a thin CLI-side helper, or accept hono/jwt as an auth-core dep — decide in design).
- `createJwtSecretLoader` lives in `auth/jwt-middleware.ts` alongside the Hono
  middleware — **split** the secret-loader (no hono) from the middleware (hono).
- Blast radius: `server` (hundreds of internal `../db/schema`, `../db/repos`,
  `../auth` imports → repoint or keep via re-export), `workers` (imports DbClient +
  schema types from server — already an allowed peer), `service` (imports schema
  namespace + repos + auth from server).

## Requirements

**Functional (refactor — behavior identical)**
- New package `packages/auth-core` (`@vibecc/paykit-auth-core`), no `hono` runtime dep
  in its core entrypoint (isolate any hono/jwt use, see design note).
- Move: `db/schema/*`, `db/client.ts`, `db/repos/{merchant,api-key,runtime-config,...}.repo.ts`
  (decide: move all repos, or only the dependency-closed set), `auth/{api-key,scope,jwt-claims,mint-admin-jwt}.ts`,
  and the secret-loader half of `jwt-middleware.ts`.
- `server` re-exports every moved symbol from its barrel (no consumer churn).
- `cli` imports auth-core only; drop `@vibecc/paykit-server` dep.
- Re-enable the skipped boundary test (`cli does not import from server`).

**Non-functional**
- Zero behavior change; all ~820+ tests green.
- No new migration. No public HTTP contract change.
- `mint-admin-jwt` hono/jwt dependency: prefer keeping HS256 `sign` usage in a
  location that does NOT force hono into the CLI runtime (e.g. auth-core depends on
  the tiny `hono/jwt` submodule only, or move signing to a `jose`/`node:crypto`
  HS256 impl). Decide in design; either is acceptable if CLI bundle stays HTTP-free.

## Related Code Files

- **Create:** `packages/auth-core/` (package.json, tsconfig, src barrel)
- **Move (git mv):** schema dir, client.ts, the repos, the auth primitive files,
  secret-loader split from jwt-middleware.ts
- **Modify:** `packages/server/src/index.ts` — re-export from auth-core
- **Modify:** `packages/server/src/**` — repoint internal relative imports (or alias)
- **Modify:** `packages/cli/package.json` — swap `@vibecc/paykit-server` → `@vibecc/paykit-auth-core`
- **Modify:** `packages/cli/src/{bin/paykit.ts,lib/bootstrap.ts}` — import from auth-core
- **Modify:** `packages/service` — import schema/repos/auth from auth-core or via server re-export
- **Modify:** `packages/core/__tests__/no-cross-imports.test.ts` — un-skip CLI rule;
  optionally add "auth-core has no hono dep" assertion
- **Modify:** Dockerfile — add `packages/auth-core` to builder + runtime COPY blocks

## Implementation Steps

1. Scaffold `@vibecc/paykit-auth-core` (mirror an existing leaf package's tsconfig).
2. `git mv` schema + client + repos + auth primitives; fix intra-package imports.
3. Split `jwt-middleware.ts`: secret-loader → auth-core; Hono middleware stays in server.
4. Server barrel re-exports all moved symbols (grep old import sites — they keep working).
5. Repoint CLI to auth-core; drop server dep.
6. Add auth-core to Dockerfile (both stages); regenerate lockfile.
7. Un-skip the boundary test; add optional "no hono in auth-core" guard.
8. `pnpm -r build && pnpm vitest run` → all green; `docker compose build` sanity.

## Success Criteria

- [ ] `@vibecc/paykit-auth-core` exists; CLI imports it, not `@vibecc/paykit-server`
- [ ] Boundary test re-enabled (CLI→server) and PASSES
- [ ] auth-core entrypoint carries no Hono HTTP-layer dependency
- [ ] All existing tests green (zero behavior change); docker build OK
- [ ] server/workers/service unaffected (re-export keeps contracts stable)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Import churn breaks server build | High | Med | Re-export from server barrel; repoint incrementally; lean on tsc |
| `mint-admin-jwt` drags hono into CLI | Med | Med | Isolate HS256 signing (hono/jwt submodule only, or node:crypto); assert no-hono |
| Circular dep auth-core ↔ server | Low | High | auth-core depends on nothing internal; server depends on auth-core (one-way) |
| Lockfile / Docker COPY miss new package | Med | Med | Regenerate lockfile; add COPY both stages; `docker compose build` verifies |
| Hidden behavior change during move | Low | High | Pure `git mv` + import repoint only; full test suite gates |
