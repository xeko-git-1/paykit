# Red-Team Plan Review — Security Adversary + Fact Checker

**Plan:** 260531-2213-GH-03-v40-service-operability-docker-sdk
**Reviewer role:** Security Adversary (attacker mindset) / verification = Fact Checker (grep+read live code)
**Date:** 2026-05-31
**Verdict:** Plan is directionally sound but its CORE security diagnosis (Phase 1 chicken-egg) is factually wrong, and several phases bake in plaintext-secret and shell-injection exposure. 8 findings below.

---

## Finding 1: Plan's Phase-1 root-cause is wrong — JWT plane is NEVER wired in service mode, so `/v1/api-keys` mint is permanently dead code; CLI becomes the SOLE, unauthenticated, cap-bypassing key-minting path

- **Severity:** Critical
- **Location:** Phase 1, "Overview" + plan.md "Bootstrap chicken-egg"
- **Flaw:** The plan claims the chicken-egg is "0 merchant = can't auth = can't mint via `/v1/api-keys` (đòi JWT/admin plane)". The real blocker is different and stronger: `buildServiceApp` mounts ONLY `apiKeyAuthMiddleware` on `/v1/*` (`packages/service/src/main.ts:78`) and never mounts the JWT middleware. `jwtSecretLoader` is built (`main.ts:162`) and passed into `buildServiceApp` (`main.ts:181`) but is **destructured and discarded** — grep shows zero `jwtAuthMiddleware` usage in `packages/service/src/`. The mint route requires `requirePlane("jwt")` (`packages/service/src/v1/router.ts:285`), so in service mode NO request can ever carry plane `"jwt"` → the mint endpoint is structurally unreachable forever, not just at cold start. Therefore the CLI is not a bootstrap convenience; it is the **only** way to ever mint a key in service mode. And the CLI path (Phase 1) skips the two guardrails the HTTP endpoint enforces: scope-subset-of-caller (`router.ts:297`) and the durable per-merchant cap `MAX_ACTIVE_KEYS_PER_MERCHANT=10` (`router.ts:45,302-303`).
- **Failure scenario:** Operator/attacker with CLI + DB URL mints unlimited keys with any scope for any merchant, with no rate cap, no audit beyond the row, and no HTTP authz — permanently, because there is no other minting path. The plan never acknowledges the JWT plane is unwired, so a future maintainer "fixing" the chicken-egg via HTTP will burn time on a dead endpoint.
- **Evidence:** `packages/service/src/main.ts:46-78,162,181` (only `apiKeyAuthMiddleware` mounted; loader discarded); `packages/service/src/v1/router.ts:285` (`requirePlane("jwt")`); `router.ts:296-310` (scope-subset + cap that CLI omits); Phase 1 step 2 lists only "validate scope-subset trước mint" against `SCOPES`, never the per-merchant cap.
- **Suggested fix:** (a) Correct the Phase-1 diagnosis: state that the JWT plane is unwired in service mode, so CLI is the permanent privileged mint path (trust boundary = DB credentials). (b) Have `bootstrap.ts` `mintForMerchant` ALSO enforce `apiKeyRepo.countActiveByMerchant` cap, so CLI and HTTP share one invariant. (c) Decide explicitly whether `/v1/api-keys` should be removed from the service (dead) or the JWT plane wired — don't leave a dead privileged endpoint advertised (see Finding 7).

---

## Finding 2: `paykit apikey mint` prints plaintext key to stdout — in containers, stdout IS the log; Phase-3 even runs it via `docker compose exec`, shipping live keys to the Docker logging driver / CloudWatch / Loki

- **Severity:** High
- **Location:** Phase 1 "Non-functional" + Risk table row 1; Phase 3 step 3 ("`docker compose exec` chạy `apikey mint`")
- **Flaw:** Phase-1 mitigation is "plaintext KHÔNG ghi log file, chỉ stdout". That mitigation is invalid in the deployment target of this very plan (Docker). A container's stdout is captured by the Docker logging driver and forwarded to whatever aggregator is configured. Phase-3 success criteria explicitly instructs running `paykit apikey mint` inside the container, and Phase-5 docs will instruct users to do the same. The plaintext key (`pk_live_...`) therefore lands in `docker logs` / centralized logging, defeating the "returned once, never stored" guarantee in `packages/server/src/auth/api-key.ts:9-11`.
- **Failure scenario:** Operator follows the documented bootstrap (`docker compose run service apikey mint ...` or an init step), live key is emitted to container stdout, ingested by Loki/CloudWatch, and is now readable by anyone with log access — a far wider audience than "save it now". Shell history (`--db-url`, `--merchant` on the command line) is a secondary leak.
- **Evidence:** `packages/server/src/auth/api-key.ts:9` ("Plaintext is returned exactly once... no read-back path"); Phase 1 Risk table ("CLI in plaintext key vào shell history/CI log | Med | High") — acknowledges the risk but the mitigation ("chỉ stdout") does not address container stdout=logs; Phase 3 step 3 and Phase 5 req both invoke mint inside Docker.
- **Suggested fix:** Mint must write the plaintext to a TTY only (detect `process.stdout.isTTY`; refuse or warn loudly when piped/non-TTY), or write to a file the operator names with `0600`, never to stdout in a container context. Document that bootstrap must be run interactively (not as a compose `command`/init that the logging driver captures). Never accept the key value as a CLI arg.

---

## Finding 3: `migrate` step interpolates `DATABASE_URL` into a shell string via `execSync` — shell injection / breakage when the DB password contains `$`, backtick, `"`, or `;`; Phase 3 deliberately routes cold-start through this sink

- **Severity:** High
- **Location:** Phase 3, "Architecture" option A + step 2 (compose command calls `node .../main.js migrate up`)
- **Flaw:** `main.ts` migrate dispatch builds `execSync(\`paykit migrate ${subCmd} --db-url "${dbUrl}"\`)` with `dbUrl = process.env.DATABASE_URL` and `subCmd = process.argv[3]` interpolated unescaped into a shell command (`packages/service/src/main.ts:133-135`). Phase 3 option A sets the compose command to invoke exactly this path on every cold start. DB connection strings routinely contain special characters in the password (auto-generated secrets often include `$`, backticks, `/`, `@`, `"`). Inside the double-quoted interpolation, a `"` or `$(...)`/backtick in the URL either breaks migration or executes arbitrary shell in the service container at startup.
- **Failure scenario:** A managed Postgres hands out password `p@ss"$(touch /tmp/pwn)`. Service container boots, runs the migrate command, the URL breaks out of the quotes and `$(...)` executes in-container before serve. Even without malice, any `$`/backtick/`"` in a legitimate password silently corrupts the `--db-url`, migration connects to the wrong DSN or fails, and cold-start "succeeds" against an unmigrated DB.
- **Evidence:** `packages/service/src/main.ts:130-136` (`execSync` with interpolated `dbUrl` and `subCmd`); `main.ts:140-143` (same pattern for `doctor`); Phase 3 "Architecture" option A command string + step 2 "Đổi command... migrate up && ... serve".
- **Suggested fix:** Replace `execSync(string)` with `execFileSync("node", ["packages/cli/dist/bin/paykit.js", "migrate", subCmd, "--db-url", dbUrl])` (arg array, no shell), or call the migration-runner library directly (no child process). Phase 3 should fix this sink as part of touching the migrate path, not just verify the `paykit` bin is on PATH.

---

## Finding 4: CLI `apikey mint --merchant <arbitrary uuid>` is an unauthenticated cross-tenant key-minting primitive; plan treats "merchant exists" as sufficient validation

- **Severity:** High
- **Location:** Phase 1, "Requirements" + "Architecture" (`merchantRepo.findById → 404 nếu vắng`)
- **Flaw:** The only validation the plan places on `--merchant` is existence (`findById` → 404 if absent). In a shared multi-tenant service DB, this means anyone holding the CLI + a DB URL can mint a fully-functional live key for ANY merchant by passing that merchant's UUID — impersonating them against `/v1/checkouts`, `/v1/refunds`, `/v1/balances`. There is no operator identity, no audit actor, no authorization layer. Combined with Finding 1 (CLI is the sole mint path) and Finding 2 (plaintext to logs), leakage of DB creds = total tenant compromise.
- **Failure scenario:** A support engineer with read/write DB access (or an attacker who obtained `DATABASE_URL` from a leaked compose file / `docker inspect`) runs `paykit apikey mint --merchant <victim-uuid> --scopes refund:write,...` and issues refunds draining the victim merchant's balance. Nothing in the design records WHO minted it.
- **Evidence:** Phase 1 Architecture block (`merchantRepo.findById → 404 nếu vắng` is the sole `--merchant` check); `packages/server/src/db/schema/api-keys.ts:15-27` (no `created_by`/actor column — the row cannot record who minted it); `packages/service/src/main.ts:74-76` (merchantId IS tenantId, so a key = full tenant access).
- **Suggested fix:** Document explicitly that the CLI's trust boundary is raw DB credentials and restrict it to a privileged operator role; treat `DATABASE_URL` as a tier-0 secret. Consider an `actor`/`created_by` field on `api_keys` for the bootstrap path so mints are attributable, and require an interactive confirmation echoing the target merchant name (from `findById`) before minting.

---

## Finding 5: Public `/v1/openapi.json` advertises the mint endpoint, so an OpenAPI-generated SDK WILL include `apiKeys.create` — directly contradicting Phase-4's "SDK does NOT expose mint (D1)"

- **Severity:** Medium
- **Location:** Phase 4, "Requirements" + Success Criteria ("SDK KHÔNG expose mint")
- **Flaw:** The SDK is generated from `/v1/openapi.json`, which is served with no auth (`packages/service/src/main.ts:88`) and DOES include the mint route `/v1/api-keys` with its request/response schema (`packages/service/src/v1/openapi.ts:81-93,107`). `openapi-fetch`/`openapi-typescript` generate types and a client covering EVERY path in the spec — there is no mechanism in the plan to strip mint. So "SDK does not expose mint" contradicts "generate from openapi.json" unless the spec is filtered before generation. Separately, serving the key-management surface (path + body schema) in a public, unauthenticated spec is needless attack-surface disclosure.
- **Failure scenario:** Generated SDK ships with `client.POST("/v1/api-keys", ...)` reachable to consumers; the Success Criterion silently fails or requires undocumented manual deletion that drifts on every `sdk:generate`. The public spec also tells any anonymous reader exactly how key minting is shaped.
- **Evidence:** `packages/service/src/v1/openapi.ts:81-93` (`mintApiKeyRoute` path `/v1/api-keys`) + `openapi.ts:107` (registered into the document) + `main.ts:88` (served no-auth); Phase 4 Success Criteria "SDK KHÔNG expose mint (plane separation D1)" vs req "Generate types + client từ /v1/openapi.json".
- **Suggested fix:** Either (a) remove the mint route from `getOpenAPIDocument()` (it's dead in service mode per Finding 1 anyway), or (b) add an explicit spec-filter step in `regenerate.ts` that drops `/v1/api-keys` before codegen, and add a test asserting the generated client has no mint method. Resolve the contradiction in the plan text.

---

## Finding 6: Phase-3 doctor "expected tables" list is factually wrong — it enumerates 12 tables but omits `reconciliation_runs`; the live schema has 13

- **Severity:** Medium
- **Location:** Phase 3, step 1 (explicit 12-table list) + plan.md "doctor hardcode 5 tables → giờ 12 migration"
- **Flaw:** The plan conflates migration count (12 files) with table count. Grepping all `*.up.sql` CREATE TABLE statements yields **13** tables; the plan's hardcoded fallback list omits `paykit.reconciliation_runs` (created in `001_init.up.sql:67`). A doctor built from the plan's list would report "all 12 present" while never checking `reconciliation_runs`, reintroducing exactly the staleness the fix targets (the current doctor at `doctor.ts:61-67` is stale the OTHER way — it lists `reconciliation_runs` but omits `merchants`/`api_keys`).
- **Failure scenario:** doctor passes green on a DB missing `reconciliation_runs`, masking a partial migration; or the "N tables present" message reports 12, contradicting the actual 13 and the manifest.
- **Evidence:** `grep -hiE "CREATE TABLE" migrations/*.up.sql` → 13 tables incl. `paykit.reconciliation_runs`; `migrations/001_init.up.sql:66-67`; Phase 3 step 1 list (12 names, no `reconciliation_runs`); current `packages/cli/src/lib/doctor.ts:61-76` (5-table list, also stale).
- **Suggested fix:** Derive expected tables programmatically from the manifest/schema (the plan's stated preferred approach) rather than hardcoding any literal list. If a literal set is unavoidable, it must include `reconciliation_runs` and total 13. Drop the "12 = migration count" framing from plan.md.

---

## Finding 7: Phase-4 adds an unpinned codegen/runtime dependency that ships inside a PAYMENT SDK to external consumers, with no version-pinning or supply-chain vetting

- **Severity:** Medium
- **Location:** Phase 4, "Non-functional" (generator choice) + Risk table
- **Flaw:** The plan proposes `openapi-fetch` as the runtime client (`createPaykitClient` middleware). `openapi-fetch` becomes a RUNTIME dependency of the published `@xeko-git-1/paykit-sdk`, pulling its transitive tree into every downstream payment integrator. The plan only gates on "peer-compat with OpenAPI 3.1" and never addresses version pinning (project rule: pin exact versions) or supply-chain review. A runtime dep in a payment-handling SDK widens the blast radius of any future compromise of that package.
- **Failure scenario:** A compromised/typosquatted `openapi-fetch` release (or transitive dep) is pulled by consumers of the payment SDK with a floating `^` range, executing attacker code in environments that handle payment auth headers (`Authorization: Bearer pk_live_...`).
- **Evidence:** Phase 4 "Non-functional" ("`openapi-fetch` + `openapi-typescript`... runtime client"); `grep openapi-fetch|openapi-typescript package.json packages/*/package.json` → not currently a dependency (net-new); Architecture block lists `src/client.ts ← createPaykitClient (openapi-fetch + auth middleware)` (runtime use).
- **Suggested fix:** Prefer `openapi-typescript` (types-only, devDependency, zero runtime footprint) + a ~30-line hand-rolled `fetch` wrapper for auth/error-mapping — keeps the published SDK runtime-dependency-free. If `openapi-fetch` is kept, pin an exact version, audit its tree, and document the supply-chain decision.

---

## Finding 8: Phases 2/3/5 expand committed `docker-compose.yml` to carry 15+ provider secrets + a single static `ADMIN_SECRET` compared non-timing-safe; plan gives no env_file/secrets guidance and Phase-5 docs risk enshrining secret-in-compose

- **Severity:** Medium
- **Location:** Phase 2 (config env), Phase 3 (compose edits), Phase 5 ("env reference (6 adapter + admin)")
- **Flaw:** `docker-compose.yml` already hardcodes `POSTGRES_PASSWORD: paykit` and an inline `DATABASE_URL` (`docker-compose.yml:10,29`). Phase 2 adds VNPAY_HASH_SECRET, MOMO_SECRET_KEY, ZALOPAY_KEY1/KEY2, etc.; Phase 5 documents an env table including `ADMIN_SECRET`. The plan gives no instruction to use `env_file:`/Docker secrets or to keep real values out of the committed file, so contributors will paste live provider secrets into a tracked file. Separately, `ADMIN_SECRET` is a single shared static value compared with a non-constant-time `!==` (`packages/service/src/main.ts:98`), and being env-based it is visible via `docker inspect`/process env — unlike the api-key path which uses `timingSafeEqual` (`packages/server/src/auth/api-key.ts:117`).
- **Failure scenario:** A developer commits `docker-compose.yml` with real VNPay/Momo HMAC secrets → secret-in-git. Or an attacker who can observe response timing on `/v1/admin/*` mounts a timing oracle against the byte-wise `!==` admin-secret compare; env exposure means any container introspection leaks the admin secret.
- **Evidence:** `docker-compose.yml:8-11,29` (hardcoded creds today); Phase 2 req (3 providers × secret envs); Phase 5 req ("env table (6 provider + ADMIN_SECRET)"); `packages/service/src/main.ts:97-100` (`secret !== adminSecret`, not timing-safe) vs `packages/server/src/auth/api-key.ts:103-119` (timingSafeEqual). config.ts:39 marks dashboard JWT as deferred to V4.4 — env admin is intentional for V4.0, but the timing/exposure caveat is undocumented.
- **Suggested fix:** Phase 2/3 should switch compose to `env_file: .env` (gitignored) with a committed `.env.example` holding placeholders only; never put real provider secrets in the tracked compose file. Phase 5 docs must show env_file/secrets, not inline values. Make the admin-secret compare constant-time (reuse `timingSafeEqual`) and document in Phase 5 that `ADMIN_SECRET` is a single static, env-exposed credential pending V4.4 JWT.

---

## Verified-correct claims (fact-check pass)

These plan claims were checked and HOLD — do not re-litigate:
- `mintApiKey` at `auth/api-key.ts:75`; `SCOPES` at `auth/scope.ts:13`; `apiKeyRepo.insert`/`countActiveByMerchant` present (`db/repos/api-key.repo.ts:23,52`). ✓
- `merchants` schema 1:1 tenant; `merchantId === tenantId` mapping (`main.ts:74-76`). ✓
- VN adapter factory configs match plan field names: VNPay `tmnCode/hashSecret/returnUrl/ipnUrl/environment` (`vnpay-adapter/src/adapter.ts:23-32`), Momo `partnerCode/accessKey/secretKey/returnUrl/ipnUrl/environment` (`momo-adapter/src/adapter.ts:28-36`), ZaloPay `appId/key1/key2/returnUrl/callbackUrl/environment` (`zalopay-adapter/src/adapter.ts:33-41`). ✓ Package names `@xeko-git-1/paykit-{vnpay,momo,zalopay}` ✓.
- Webhooks mounted top-level outside `/v1` auth glob (`main.ts:66`), signature verified inside adapter; VN adapters expose `verifyWebhookSignature` (signed path, not BitPay-style `resolveWebhook`) — webhooks correctly stay HTTP-unauthenticated with in-adapter signature checks. ✓ (Phase 2 risk-row claim is accurate.)
- `migrate` advisory-lock idempotency exists (migration-runner skip-on-lock, `paykit.ts:58-60`). ✓

## Unresolved questions for planner

1. Is `/v1/api-keys` (JWT-plane mint) intended to remain in service mode at all? If the JWT plane is never wired (Finding 1), it is dead — confirm remove vs wire before Phase 4 generates an SDK from a spec that includes it (Finding 5).
2. What is the intended trust boundary for the CLI — operator-only with DB creds as tier-0 secret? If yes, state it; if not, the cross-tenant mint (Finding 4) needs an authz story.
3. Phase-1 open question ("apikey mint reads DB directly") is fine, but does bootstrap mint enforce the per-merchant cap to match HTTP invariant (Finding 1c)?

**Status:** DONE — Plan's Phase-1 root cause is factually wrong (JWT plane unwired ⇒ mint endpoint permanently dead, CLI is sole unauthenticated mint path); plaintext-key-to-docker-logs and `execSync(DATABASE_URL)` shell-injection are concrete High-severity exposures the plan introduces/ignores; doctor table list is off-by-one (13 not 12, omits reconciliation_runs).
