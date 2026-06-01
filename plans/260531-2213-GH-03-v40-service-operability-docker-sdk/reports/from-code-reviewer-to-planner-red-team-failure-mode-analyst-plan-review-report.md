# Red-team review (Failure Mode Analyst) — V4.0 service operability plan

Reviewer perspective: Murphy's Law / Flow Tracer. Tôi trace từng luồng end-to-end plan hứa "chạy ok"
và tìm chỗ vỡ. Mọi finding có evidence `file:line`. Không khen.

Scope: `plans/260531-2213-GH-03-v40-service-operability-docker-sdk/` (plan.md + phase-01..05).
Verified against: service/main.ts, service/Dockerfile, docker-compose.yml, cli/src/bin/paykit.ts,
cli/src/lib/migration-runner.ts, cli/src/lib/doctor.ts, migrations/*.up.sql, v1/openapi.ts, ci.yml.

---

## Finding 1: ENTRYPOINT không bị override → compose `command` chuỗi biến thành argv của `main.js` → "Unknown command"
- **Severity:** Critical
- **Location:** Phase 3, "Architecture" option A (line 35) + "Implementation Steps" step 2 (line 66)
- **Flaw:** Plan đổi `command:` của compose thành `["sh","-c","node ... migrate up && node ... serve"]`
  nhưng Dockerfile có `ENTRYPOINT ["node","packages/service/dist/main.js"]` (Dockerfile:82). Trong Docker,
  khi ENTRYPOINT là exec-form, `command` (CMD) trở thành **args nối sau ENTRYPOINT**, KHÔNG thay nó.
  Effective command = `node packages/service/dist/main.js sh -c "node ... && node ..."`.
- **Failure scenario:** `docker compose up` → main.ts đọc `process.argv[2] === "sh"` (main.ts:128) →
  rơi xuống `console.error("Unknown command: sh ...")` + `process.exit(1)` (main.ts:190-191) → container
  chết ngay, chưa từng migrate, chưa từng serve. Cold-start vỡ 100% ở dòng đầu tiên.
- **Evidence:** Dockerfile:82-83 (`ENTRYPOINT [...]` + `CMD ["serve"]`); main.ts:128 (`argv[2] ?? "serve"`),
  main.ts:190-191 (unknown→exit 1); plan phase-03 line 35 & 66 chỉ đổi `command`, không nhắc `entrypoint: []`.
- **Suggested fix:** Trong compose service thêm `entrypoint: []` (clear) RỒI đặt `command:
  ["sh","-c","..."]`; hoặc dùng `entrypoint: ["sh","-c"]` + `command: ["..."]`. Plan phải nêu rõ
  override entrypoint, không chỉ command.

---

## Finding 2: `paykit` bin KHÔNG có trong PATH runtime image — `execSync("paykit migrate")` chết; command chính của plan vẫn route qua nó
- **Severity:** Critical
- **Location:** Phase 3, "Implementation Steps" step 2 (line 66-70) + Risk table (line 89-90)
- **Flaw:** main.ts `migrate` delegate bằng `execSync("paykit migrate ${subCmd} ...")` (main.ts:135).
  `paykit` là bin của `@vibecc/paykit-cli` (cli/package.json:8-10 `"bin":{"paykit":"./dist/bin/paykit.js"}`).
  Runtime stage Dockerfile chỉ COPY các `dist/` + `pnpm install --prod` (Dockerfile:51-74), KHÔNG link bin
  vào PATH, KHÔNG set `ENV PATH=.../node_modules/.bin` (grep: chỉ có `RUN pnpm install`, không `ln -s`,
  không `ENV PATH`). pnpm workspace bin nằm ở `node_modules/.bin` — KHÔNG có trên PATH của `/bin/sh`.
  Command "primary" của plan (line 35/66) gọi `node main.js migrate up` → vẫn đi qua execSync(`paykit`),
  nên KHÔNG bypass được lỗi. Fix đúng (`node packages/cli/dist/bin/paykit.js`) chỉ nằm trong cột
  *mitigation của risk table*, không phải đường chính.
- **Failure scenario:** Giả sử Finding 1 đã fix; `node main.js migrate up` chạy → execSync spawn `sh -c
  "paykit migrate up ..."` → `sh: paykit: not found` → execSync throw → main.ts catch fatal → exit 1 →
  `&& serve` short-circuit → container chết. Migrate không bao giờ chạy.
- **Evidence:** main.ts:133-135 (`execSync("paykit migrate ...")`); Dockerfile:74,82 (prod install + entrypoint,
  không có bin link/PATH); cli/package.json:8-10 (bin name). Plan tự thừa nhận risk ở phase-03:89-90 nhưng
  để command chính (line 35/66) vẫn gọi `main.js migrate`.
- **Suggested fix:** Bắt buộc (không phải "fallback"): hoặc (a) sửa main.ts migrate gọi
  `node packages/cli/dist/bin/paykit.js migrate ...` thay vì `paykit`; hoặc (b) compose gọi thẳng
  `node packages/cli/dist/bin/paykit.js migrate up && node packages/service/dist/main.js serve`. Phải
  nâng từ risk-mitigation lên Implementation Step bắt buộc.

---

## Finding 3: doctor table-list SAI — schema thực có 13 bảng, plan hardcode 12 và BỎ SÓT `reconciliation_runs` → "fix" để doctor vẫn báo sai
- **Severity:** Critical (fix chính của phase lại tạo bug mới)
- **Location:** Phase 3, "Implementation Steps" step 1 (line 62-64) + plan.md line 31 ("giờ 12 migration")
- **Flaw:** Plan nhầm "12 migration = 12 bảng". Thực tế: 12 migration nhưng **13 bảng domain** (4 migration
  002/009/010/011 chỉ ALTER, không tạo bảng; 001_init tạo nhiều bảng gồm `reconciliation_runs`). Danh sách
  hardcode trong plan (line 62-64) liệt kê đúng 12 tên và **THIẾU `reconciliation_runs`**. doctor hiện tại
  cũng đang sai theo kiểu khác (chỉ check 5 bảng cũ: payment_transactions, ledger_entries, balance_projections,
  webhook_events, reconciliation_runs — doctor.ts:61-67).
- **Failure scenario:** Implement đúng plan → `expected` set 12 tên (thiếu reconciliation_runs). doctor check
  `missing = expected.filter(t => !present.has(t))`. Sau migrate, present có đủ 13 → missing rỗng → in
  "all 12 paykit tables present". Sai số (13 chứ không 12) VÀ vĩnh viễn không phát hiện được nếu
  `reconciliation_runs` bị drop/thiếu (vì không nằm trong expected). Task framing "doctor stays broken" đúng:
  doctor vẫn lệch.
- **Evidence:** grep `CREATE TABLE ... paykit.*` trên `migrations/*.up.sql` → 13 bảng distinct:
  api_keys, balance_projections, customers, idempotency_records, ledger_entries, merchants,
  payment_transactions, pending_refunds, **reconciliation_runs**, runtime_config, subscription_events,
  subscriptions, webhook_events. `reconciliation_runs` ở migrations/001_init.up.sql. Plan phase-03:62-64 liệt
  kê 12 tên, không có reconciliation_runs. doctor.ts:76 (`"all 5 paykit tables present"`).
- **Suggested fix:** Bỏ hardcode hoàn toàn. Derive expected từ nguồn duy nhất (parse `CREATE TABLE` trong
  migration up files, hoặc thêm `expectedTables` vào manifest.json). Nếu vẫn hardcode: phải gồm đủ 13 tên +
  reconciliation_runs. Plan cũng phải sửa câu "12 migration" thành "13 tables / 12 migrations".

---

## Finding 4: `--frozen-lockfile` + 3 dep VN mới (phase 2) và server-dep cho CLI (phase 1) → `pnpm install` trong Docker fail "lockfile out of date"
- **Severity:** High
- **Location:** Phase 2, "Related Code Files" (line 57-58) + Phase 1, "Related Code Files" (line 61)
- **Flaw:** Cả 2 stage Dockerfile dùng `pnpm install --frozen-lockfile` (Dockerfile:25, 74). Phase 2 thêm 3
  workspace dep vào `packages/service/package.json` (`@vibecc/paykit-vnpay/-momo/-zalopay`), Phase 1 thêm
  `@vibecc/paykit-server` vào `packages/cli/package.json`. Đổi dependency graph → `pnpm-lock.yaml` PHẢI được
  regenerate + commit. Không phase nào nhắc bước này; bước verify chỉ ghi `pnpm install` (phase-02:76) chứ
  không nói regenerate lockfile, và `docker compose build` (phase-03) dùng frozen.
- **Failure scenario:** Dev sửa package.json, `pnpm install` local (cập nhật lockfile trong working tree
  nhưng quên commit, hoặc CI checkout lockfile cũ) → `docker compose build` chạy `pnpm install --frozen-lockfile`
  → "ERR_PNPM_OUTDATED_LOCKFILE" → build fail trước cả khi tới migrate. Phase 3 "verify docker build" vỡ.
- **Evidence:** Dockerfile:25 & 74 (`--frozen-lockfile`); phase-02:57 (3 workspace dep mới), phase-01:61
  (server dep cho cli); không có dòng nào yêu cầu regenerate/commit `pnpm-lock.yaml`.
- **Suggested fix:** Thêm Implementation Step bắt buộc ở phase 1 & 2: chạy `pnpm install` (no-frozen) để
  cập nhật `pnpm-lock.yaml` rồi COMMIT lockfile; thêm vào Success Criteria "lockfile updated + committed".

---

## Finding 5: Multi-instance `pg_try_advisory_lock` skip → serve-before-migrate race; plan claim "nhiều instance an toàn" sai sắc thái
- **Severity:** High
- **Location:** Phase 3, "Non-functional" (line 25-26) + Risk table (line 91)
- **Flaw:** Plan ghi "Migrate idempotent (advisory-lock đã có) — chạy nhiều instance không double-apply" và
  risk table coi skip = "skip nếu HEAD". Thực tế `migrateUp` dùng **non-blocking** `pg_try_advisory_lock`
  (migration-runner.ts:25-29): nếu instance khác đang giữ lock, trả `{applied:[], skipped:true}` NGAY (không
  chờ). cli in "another instance holds the lock — skipped (no-op)" và **exit 0** (paykit.ts:58-61). Với
  compose `migrate up && serve`, exit 0 → serve chạy tiếp DÙ migrate chưa thực sự apply xong ở instance kia.
- **Failure scenario:** Scale 2 replica cold-start đồng thời. Instance A giữ lock, đang chạy 13 migration.
  Instance B `try_lock` fail → skip → exit 0 → B `serve` ngay → B nhận request → query bảng chưa tồn tại
  (A chưa COMMIT xong) → 500 hàng loạt cho tới khi A xong. "Không double-apply" đúng, nhưng "an toàn nhiều
  instance" thì SAI: có cửa sổ serve-before-ready.
- **Evidence:** migration-runner.ts:24-30 (`pg_try_advisory_lock`, non-blocking, return skipped),
  paykit.ts:58-61 (skipped→log→return, exit 0); plan phase-03:26 & 91 mô tả skip như an toàn.
- **Suggested fix:** Hoặc (a) dùng blocking `pg_advisory_lock` + sau khi acquire kiểm tra HEAD rồi serve;
  hoặc (b) tách migrate thành init-container chạy 1 lần (compose option B mà plan đã liệt nhưng loại bỏ),
  serve `depends_on migrate: completed_successfully`. Với dev 1-instance thì option A ok — nhưng plan phải
  bỏ claim "multi-instance safe" hoặc chọn option B cho >1 replica.

---

## Finding 6: Half-applied migration + KHÔNG có restart policy + `sh &&` short-circuit → container chết, schema dở dang, không recovery loop
- **Severity:** Medium
- **Location:** Phase 3, "Architecture" option A (line 35) + "Risk Assessment" (toàn bảng — thiếu row này)
- **Flaw:** `migrateUp` apply từng migration trong BEGIN/COMMIT riêng (migration-runner.ts:86-94). Nếu
  migration thứ k fail (SQL lỗi / mất kết nối), 1..k-1 đã COMMIT, k rollback, throw → main.js exit 1 →
  `&& serve` không chạy. docker-compose KHÔNG có `restart:` (grep: none) → container ở trạng thái Exited,
  DB ở schema dở (k-1/13 bảng). Plan không có row risk nào cho "migrate fail giữa chừng".
- **Failure scenario:** Migration 012 (merchants/api_keys) lỗi do FK/constraint trên prod-like data → bảng
  001-011 đã có, 012 thiếu → container chết. `docker compose up` lại: migrate resume từ 012 (idempotent OK)
  nếu lỗi transient; nếu lỗi deterministic → mỗi lần up đều chết tại 012, không restart policy = phải can
  thiệp tay. doctor lúc này báo missing merchants/api_keys (nhưng xem Finding 3 — list sai).
- **Evidence:** migration-runner.ts:82-99 (per-migration txn, throw lên trên); docker-compose.yml (không có
  `restart`); main.ts:201-204 (fatal→exit 1). Plan phase-03 risk table không phủ case này.
- **Suggested fix:** Thêm row risk + quyết định: (a) document rằng migrate fail → fix-forward thủ công;
  (b) cân nhắc `restart: on-failure` chỉ cho migrate-init (option B), KHÔNG cho serve (tránh crash-loop
  che lỗi). Nêu rõ recovery runbook trong phase 5 docs.

---

## Finding 7: E2E cold-start KHÔNG chạy được trong CI (ci.yml không có Docker/Postgres service) → lời hứa cốt lõi V4.0 không bao giờ được gate
- **Severity:** Medium
- **Location:** Phase 5, "Non-functional" (line 28-31) + Risk table (line 82); Phase 3 Success Criteria (line 79-83)
- **Flaw:** Phase 3 + 5 đặt acceptance lên `docker compose up` thật và e2e cold-start. Nhưng `.github/workflows/ci.yml`
  CHỈ có `pnpm install/typecheck/lint/build/test` trên ubuntu, KHÔNG có `services: postgres`, KHÔNG có
  docker build/compose step. Phase 5 thừa nhận "CI không có Docker → skippable-by-env" — nghĩa là toàn bộ
  flow migrate→serve→/healthz (chính là điểm V4.0 sửa) chỉ verify thủ công, không có gì gate regression.
- **Failure scenario:** Sau merge, ai đó đổi Dockerfile/compose/main.ts (vd làm hỏng lại Finding 1/2) →
  `pnpm test` xanh (unit không đụng Docker) → CI pass → cold-start vỡ chỉ phát hiện khi deploy thật. "733
  tests pass" tạo cảm giác an toàn giả.
- **Evidence:** ci.yml:1-27 (không có `services:`/postgres/docker); phase-05:82 (CI không Docker → skippable);
  phase-03:71-75 (verify cold-start "THẬT" — chỉ local).
- **Suggested fix:** Thêm 1 CI job dùng `services: postgres:16` (GitHub Actions hỗ trợ sẵn) chạy ít nhất
  `migrate up` + `buildServiceApp` + smoke `/readyz` (không cần Docker daemon). Hoặc job riêng `docker compose
  up` qua docker-in-docker. Nếu giữ thủ công: plan phải hạ kỳ vọng và nêu rõ cold-start KHÔNG được CI bảo vệ.

---

## Finding 8: SDK snapshot test cần cross-package dep vào service (chưa khai báo); snapshot so pure-fn chứ không so bytes served → vẫn có khe drift
- **Severity:** Medium
- **Location:** Phase 4, "Related Code Files" (line 62) + "Implementation Steps" step 2 (line 72)
- **Flaw:** `spec-snapshot.test.ts` so `packages/sdk/openapi.json` (committed) với "service `getOpenAPIDocument()`".
  Để import hàm đó, `packages/sdk` phải có devDep `@vibecc/paykit-service` — plan "Related Code Files" (line
  56-62) không liệt dep này. Ngoài ra service serve qua `c.json(getOpenAPIDocument())` (main.ts:88); snapshot
  so trực tiếp pure-fn, KHÔNG so bytes thực `/v1/openapi.json` HTTP → khác biệt serialization/ordering không
  được phát hiện (dù rủi ro thấp). Spec là OpenAPI **3.1** (openapi.ts:109 `getOpenAPI31Document` / "3.1.0")
  — Phase 4 đã đúng khi đặt blocking gate verify 3.1 generator (phase-04:66-69), điểm này ổn.
- **Failure scenario:** SDK package được build/test độc lập (`pnpm --filter @vibecc/paykit-sdk`) → import
  `@vibecc/paykit-service` fail vì chưa khai dep → test không compile, hoặc tệ hơn dev hardcode copy spec →
  snapshot tự so chính nó, mất tác dụng chống drift.
- **Evidence:** main.ts:88 (`c.json(getOpenAPIDocument())`); openapi.ts:99-118 (pure fn, 3.1.0); phase-04:56-62
  (Related Files không có devDep service); phase-04:72 (snapshot === service getOpenAPIDocument).
- **Suggested fix:** Khai báo `@vibecc/paykit-service` (devDep) trong sdk package.json + thêm vào lockfile
  (xem Finding 4). Cân nhắc snapshot so qua `buildServiceApp().request("/v1/openapi.json")` để bắt cả lớp
  serialization, không chỉ pure fn.

---

## Tổng hợp mức độ
- **Critical (3):** F1 (entrypoint/command), F2 (paykit bin PATH), F3 (doctor 13-vs-12 + thiếu reconciliation_runs).
  → 3 cái này chặn cứng chính mục tiêu "cold-start qua Docker chạy ok". F1+F2 stack lên nhau: phải fix CẢ HAI
  mới qua được dòng migrate đầu tiên.
- **High (2):** F4 (frozen-lockfile regen), F5 (multi-instance serve-before-migrate race).
- **Medium (3):** F6 (half-migrate no-recovery), F7 (CI không gate cold-start), F8 (SDK snapshot dep/drift).

## Điểm plan làm đúng (để không sửa nhầm)
- Phase 2 CÓ liệt "Modify Dockerfile COPY 3 package" (phase-02:58) — không bỏ sót COPY (chỉ thiếu lockfile, F4).
- Phase 4 CÓ blocking gate verify OpenAPI 3.1 generator trước khi thêm dep (phase-04:66-69) — đúng, spec là 3.1.
- VN adapter factories + package names verify khớp plan: `createVnpayAdapter/createMomoAdapter/createZaloPayAdapter`,
  `@vibecc/paykit-vnpay/-momo/-zalopay` đều tồn tại.
- Không có `DROP TABLE` trong up migrations → migrate up thuần additive (giảm rủi ro data-loss khi re-run).

## Unresolved questions
1. [F5] V4.0 target có bao giờ chạy >1 replica service không? Nếu có → bắt buộc option B (migrate init-container).
   Nếu chỉ dev 1-instance → bỏ claim "multi-instance safe", giữ option A nhưng vẫn cần fix F1/F2.
2. [F7] Có chấp nhận thêm CI job `services: postgres` (rẻ, không cần Docker daemon) để gate migrate+smoke không?
3. [F3] Nguồn chân lý cho expected-tables nên là manifest.json (thêm field) hay parse migration SQL? Cần chốt
   để doctor không lệch lần sau khi thêm migration 013+.
