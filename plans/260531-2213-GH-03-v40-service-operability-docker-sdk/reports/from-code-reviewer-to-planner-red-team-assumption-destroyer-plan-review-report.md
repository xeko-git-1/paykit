# Red-Team Plan Review — Assumption Destroyer / Scope Auditor

**Plan:** 260531-2213-GH-03-v40-service-operability-docker-sdk
**Reviewer perspective:** Hostile — unstated dependencies, false "will work" claims, contract mismatches.
**Verdict:** Plan is directionally sound (field names, imports, migration 012 all verified real) but contains **2 Critical / 2 High** defects that will break the keystone phase and the acceptance test as written.

---

## Finding 1: CLI repo calls pass a raw `pg.Client` where Drizzle `DbOrTx` is required
- **Severity:** Critical
- **Location:** Phase 1, "Architecture" + "Implementation Steps (TDD)" step 2
- **Flaw:** The plan's architecture diagram says `withClient(dbUrl) → merchantRepo.insert(db, {name})` and step 2 says "Wire 2 command … mirror `migrate up` action + `withClient`". But the existing `withClient` hands the callback a raw `pg.Client` (`paykit.ts:36-48`), while both repos require a Drizzle handle: `merchant.repo`/`api-key.repo` are typed `DbOrTx = NodePgDatabase | NodePgTransaction` and call `db.insert(...).values(...).returning()` (`api-key.repo.ts:23-27`, `client.ts:12-14`). A `pg.Client` has no `.insert()` → compile error + runtime crash. Mirroring `migrate up` (which legitimately uses raw `pg.Client` for SQL strings) does NOT produce a usable repo handle.
- **Failure scenario:** `paykit merchant create` is implemented per the diagram, ships, and throws `db.insert is not a function` on first invocation. This is the keystone phase — every later phase's e2e depends on it.
- **Evidence:** `packages/cli/src/bin/paykit.ts:16,36-48` (raw `Client`); `packages/server/src/db/repos/api-key.repo.ts:23` (`db.insert(apiKeys)`); `packages/server/src/db/client.ts:12-14` (`DbOrTx` = Drizzle).
- **Suggested fix:** Make the bootstrap path wrap the client: `const db = drizzle(client)` before calling repos. The risk table (row 2) hints at this, but the Architecture diagram and Steps contradict it — fix the diagram/steps to show the `drizzle(pg.Client)` wrap explicitly, and add `drizzle-orm` to CLI `dependencies` (currently absent — `packages/cli/package.json:26-29`).

---

## Finding 2: SDK + e2e acceptance test use a `checkouts.create` payload that does not exist in the `/v1` contract
- **Severity:** Critical
- **Location:** Phase 4 "Architecture" (consumer example) + Phase 5 step 1 (e2e)
- **Flaw:** Both phases call `checkouts.create({ provider, amountMicros, currency })` (Phase 4 line 51; Phase 5 line 59: `{provider:"sepay", amountMicros, currency:"VND"}`). The real request DTO `CreateCheckoutBody` has fields `{ amountUsd?, amountVnd?, provider, discountCode? }` and is declared `.strict()` (rejects unknown keys). There is no `amountMicros` and no `currency` field. A `.strict()` schema will 400 on the unknown keys.
- **Failure scenario:** Phase 5 acceptance e2e ("cold-start → bootstrap → mint → checkout → 2xx + DTO khớp") sends `{amountMicros, currency}`, gets HTTP 400 validation error, and the headline acceptance criterion ("prove drop-in + Docker works") fails. The SDK example in docs would also be wrong, misleading every downstream consumer.
- **Evidence:** `packages/service/src/v1/dto.ts:17-24` (`CreateCheckoutBody` = `amountUsd|amountVnd|provider|discountCode`, `.strict()`); plan Phase 4 line 51 + Phase 5 line 59 use `amountMicros`/`currency`.
- **Suggested fix:** Rewrite SDK/e2e examples to the real contract, e.g. `checkouts.create({ provider: "sepay", amountVnd: 50000 })`. Note SePay is VND → use `amountVnd`, not `amountUsd`. Update Phase 4 success criteria and Phase 5 e2e body accordingly.

---

## Finding 3: Phase 3 "option A" compose command re-enters the same `paykit`-bin-not-in-PATH trap it claims to fix
- **Severity:** High
- **Location:** Phase 3, "Architecture" (option A) + step 2 + Risk row 1-2
- **Flaw:** Option A's command is `node packages/service/dist/main.js migrate up && … serve` (lines 35-36, 66). But `main.js migrate` internally shells out via `execSync("paykit migrate up …")` (`main.ts:130-136`). `execSync` uses the default `PATH`, which does not include `./node_modules/.bin`, so the workspace `paykit` bin is unresolved at runtime. Option A therefore does NOT bypass the failure — it just reaches it one layer deeper. The plan's own risk rows (High/High) flag the bin issue and propose calling `node packages/cli/dist/bin/paykit.js migrate up` directly, but option A as written ignores that fix.
- **Failure scenario:** `docker compose up` from a clean volume → migrate step runs `main.js migrate` → `execSync('paykit …')` → `sh: paykit: not found` → exit 127 → serve never starts → cold-start acceptance fails.
- **Evidence:** `packages/service/src/main.ts:130-136` (`execSync(\`paykit migrate ${subCmd}\`)`); `packages/service/Dockerfile:74-83` (`pnpm install --prod`; no explicit PATH export, no `npm link`); plan Phase 3 lines 35-36, 66, 89-90.
- **Suggested fix:** Make the compose command call the CLI entry directly and skip `main.js migrate`: `command: ["sh","-c","node packages/cli/dist/bin/paykit.js migrate up --db-url \"$DATABASE_URL\" && node packages/service/dist/main.js serve"]`. Then this phase should also fix `main.ts` migrate/doctor to import the migration lib directly rather than `execSync('paykit')`, or the gap remains for non-compose deploys.

---

## Finding 4: Phase 3 doctor expected-table list omits `reconciliation_runs`; the "12 tables" figure is wrong (actual = 13)
- **Severity:** High
- **Location:** Phase 3 step 1 (table enumeration) + Phase 5 ("5→12 tables")
- **Flaw:** Plan enumerates 12 tables and instructs `EXPECTED.size` messaging on that list — but the schema actually has **13** tables. The plan's list omits `reconciliation_runs` (created in `001_init`). Fixing doctor with this list trades the old `all 5` bug for a new false-negative: a present table goes unchecked and the dynamic count prints "13" while the code's EXPECTED set has only 12 (or, if hardcoded to 12, drift again). Phase 5 propagates the same error into docs ("5→12").
- **Failure scenario:** doctor reports "all 12 paykit tables present" on a 13-table DB; a future drop of `reconciliation_runs` is never detected by the health check that exists specifically to catch missing tables.
- **Evidence:** `grep "CREATE TABLE paykit\."` across `migrations/*.up.sql` → 13 tables incl. `reconciliation_runs` (`001_init.up.sql:67`); plan Phase 3 lines 62-64 list 12 and omit it; current hardcode `all 5` at `packages/cli/src/lib/doctor.ts:61-76`.
- **Suggested fix:** Derive the expected set from the schema/manifest programmatically (manifest has the migrations but not table names — prefer enumerating the Drizzle schema tables, or `pgClass` query) rather than a hand-typed list. If hardcoding, the correct count is 13 and must include `reconciliation_runs`. Fix Phase 5 docs to "13".

---

## Finding 5: CLI `apikey mint` bypasses the per-merchant key-cap and scope-subset guards that the `/v1/api-keys` endpoint enforces
- **Severity:** Medium
- **Location:** Phase 1, "Functional" + "Architecture"
- **Flaw:** Plan reuses `mintApiKey()` + `apiKeyRepo.insert()` directly. That is the low-level primitive; it does NOT run `countActiveByMerchant` (the durable per-merchant active-key cap, `api-key.repo.ts:52-58`) nor any scope-subset check against a caller. The plan claims to "reuse mintApiKey", conflating the primitive with the endpoint's authorization wrapper.
- **Failure scenario:** An operator scripts `paykit apikey mint` in a loop / CI and silently exceeds the cap that the HTTP plane enforces — two code paths with divergent invariants for the same table. Acceptable for the genuine bootstrap (first key, no caller to subset against), but the plan does not state this as an intentional exception.
- **Evidence:** `packages/server/src/db/repos/api-key.repo.ts:52-58` (`countActiveByMerchant` exists for cap enforcement); plan Phase 1 lines 27,46-48 (direct `mintApiKey`+`insert`, no cap/subset step).
- **Suggested fix:** State explicitly that CLI bootstrap intentionally bypasses the cap (out-of-band admin path) OR have `mintForMerchant` call `countActiveByMerchant` and refuse past a sane limit. Either way, document the divergence so the two planes don't drift.

---

## Finding 6: Phase 2 Dockerfile changes are larger than "copy 3 package" — 6 COPY lines across 2 stages + 3 builder install lines, none present today
- **Severity:** Medium
- **Location:** Phase 2 "Related Code Files" (Dockerfile) + Risk row 1
- **Flaw:** The current Dockerfile copies only stripe/sepay/nowpayments. Adding 3 VN adapters requires: (a) 3 `COPY packages/{vn}/package.json` lines in the builder BEFORE `pnpm install --frozen-lockfile` (line 25) or the workspace install resolves wrong; (b) 3 `COPY packages/{vn}/ …` source lines before `pnpm -r build` (line 38); (c) 3 `COPY --from=builder … dist + package.json` in runtime; (d) `pnpm install --prod` (line 74) only pulls them if they're declared service deps. Miss any one and either build fails or the adapter is silently absent at runtime (lazy `import()` throws only when creds are set). Plan says "copy 3 package (builder + runtime)" — undercounts the actual edit surface and the frozen-lockfile ordering constraint.
- **Failure scenario:** Builder package.json line added but source-copy line forgotten → `pnpm -r build` can't find the adapter source → build fails late; or runtime dist-copy forgotten → service starts but `createVnpayAdapter` import throws only once VNPAY_* creds are provided in prod.
- **Evidence:** `packages/service/Dockerfile:16-22` (only 3 adapters), `:32-34`, `:61-68`, `:25` (`--frozen-lockfile`), `:74` (`--prod`).
- **Suggested fix:** Spell out all 6+3 Dockerfile line additions in the phase and add a checklist item; also note `pnpm-lock.yaml` must be regenerated (frozen-lockfile will fail if the 3 new workspace deps aren't already in the lock).

---

## Finding 7: Phase 4 generator peer-compat with the OpenAPI 3.1 spec is an unverified peer claim; neither tool is in the repo
- **Severity:** Medium
- **Location:** Phase 4, "Non-functional" + Risk row 1
- **Flaw:** Plan assumes `openapi-typescript` + `openapi-fetch` consume the `getOpenAPI31Document({openapi:"3.1.0"})` output. Neither package exists anywhere in the repo or lockfile today, and the spec emits relative `servers:[{url:"/"}]`. 3.1 vs 3.0 generator support genuinely differs across versions. The plan correctly gates this ("blocking gate") but provides no evidence the gate passes and the fallback ("types-only + hand wrapper") is hand-wavy.
- **Failure scenario:** A new dep is added, types generate with `unknown`/`never` for 3.1-only constructs (e.g. `null` type unions from `.nullable()` in dto.ts), the SDK is partly untyped, and Phase 4 stalls without a concrete fallback design.
- **Evidence:** `grep openapi-typescript|openapi-fetch` → absent from all `package.json` + `pnpm-lock.yaml`; spec is 3.1 at `packages/service/src/v1/openapi.ts:109-117`; `.nullable()` 3.1 unions at `dto.ts:49,74`.
- **Suggested fix:** During the gate, pin specific tested versions (openapi-typescript ≥7 supports 3.1) and commit the generated types diff as proof before wiring the client. Define the fallback wrapper's exact shape, not just "thin wrapper tay".

---

## Finding 8: Baseline "V4 phase 1-5 done, 733 tests pass" is unverified — the entire V4 surface is uncommitted working-tree state
- **Severity:** Medium
- **Location:** plan.md "Overview" + "Dependencies"
- **Flaw:** The plan builds on "260529-1312 V4 phases 1-5 đã xong … 733 test pass" as settled fact. But `auth/`, `db/repos/api-key.repo.ts`, `db/schema/merchants.ts|api-keys.ts`, migration 012, and the `/v1` surface are all untracked/modified in the working tree (per git status) with no V4 implementation commit in `git log` (latest is a docs/plans commit). The dependency targets the plan cites (`mintApiKey`, `SCOPES`, `apiKeyRepo`, barrel exports) do exist and are correctly referenced — but they live only in an uncommitted state.
- **Failure scenario:** If that working tree is stashed/reverted or partially recommitted differently, every Phase 1 import (`@vibecc/paykit-server` → `mintApiKey`/`apiKeyRepo`/`SCOPES`) and the "no new migration needed" claim silently break. The "733 tests pass" figure is not reproducible from git.
- **Evidence:** git status: `?? packages/server/src/auth/`, `?? .../api-key.repo.ts`, `?? .../merchants.ts`, `?? migrations/012_*`; `git log` top commit `fe199fb docs(plans): …` (no V4 impl commit). Imports themselves verified real: `packages/server/src/index.ts:52-66,94` exports `mintApiKey`, `SCOPES`, `apiKeyRepo`.
- **Suggested fix:** Add a Phase 0 / precondition: commit (or confirm committed) the 260529-1312 V4 surface and re-run the suite to re-establish the 733-pass baseline before starting Phase 1. State the dependency on uncommitted code explicitly in plan.md.

---

## Verified-OK (attacked, found solid — no action)
- Barrel exports `mintApiKey`, `apiKeyRepo`, `SCOPES`, `merchants` types — all present (`index.ts:52-66,94`). Phase 1 import claim holds.
- `MintApiKeyResult.record` = `{merchantId,keyHash,keyPrefix,mode,scopes}` is directly insertable as `NewApiKey` (all required cols present; keyId/timestamps default) (`api-key.ts:49-56` vs `api-keys.ts:15-27`). No missing fields.
- No `server → cli` import → no dependency cycle when CLI adds `@vibecc/paykit-server` (grep clean).
- Phase 2 VN field names all correct: vnpay `tmnCode/hashSecret/returnUrl/ipnUrl/environment`; momo `partnerCode/accessKey/secretKey/returnUrl/ipnUrl`; zalopay `appId/key1/key2/returnUrl/callbackUrl` (verified in each `adapter.ts`). The plan even pre-empts the `callbackUrl` vs `ipnUrl` trap correctly.
- Migration 012 creates BOTH `merchants` + `api_keys` with the columns the repos expect → "no new migration" claim is true.

## Unresolved questions
1. Is the 260529-1312 V4 surface intended to be committed before this plan starts, or are both plans landing in one branch? (Finding 8)
2. SePay checkout: confirm `amountVnd` (not `amountUsd`) is the correct field for the e2e provider — DTO allows either but SePay is VND-only. (Finding 2)
3. Should CLI `apikey mint` enforce the per-merchant cap, or is bootstrap an intentional cap-bypass? (Finding 5)

**Status:** DONE — Plan's verifiable facts (imports, field names, migration 012) check out, but Findings 1-4 (raw-pg-vs-drizzle handle, nonexistent checkout payload in SDK/e2e, option-A PATH trap, 12-vs-13 table miss) are concrete blockers that must be fixed before Phase 1/3/4/5 can pass.
