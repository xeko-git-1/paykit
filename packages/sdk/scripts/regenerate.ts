/**
 * Regenerate the committed OpenAPI snapshot + generated TS types.
 *
 * Pipeline:
 *   1. Dump the live spec from the service (getOpenAPIDocument()).
 *   2. Filter out the jwt-plane mint route POST /v1/api-keys (F11) — the SDK is
 *      the api-key plane and must NOT expose key minting. Removing it from the
 *      snapshot keeps the generated surface free of an apiKeys.create method.
 *   3. Write packages/sdk/openapi.json (the committed snapshot).
 *   4. Run openapi-typescript on the snapshot → src/generated/types.ts.
 *
 * Run: pnpm --filter @xeko-git-1/paykit-sdk sdk:generate
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOpenAPIDocument } from "@xeko-git-1/paykit-service";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const SNAPSHOT_PATH = resolve(PKG_ROOT, "openapi.json");
const TYPES_PATH = resolve(PKG_ROOT, "src", "generated", "types.ts");

/** Paths the SDK must never expose (jwt/admin plane — see F11). */
const EXCLUDED_PATHS = ["/v1/api-keys"];

function buildFilteredSpec(): Record<string, unknown> {
  const spec = getOpenAPIDocument() as { paths?: Record<string, unknown> };
  const paths = { ...(spec.paths ?? {}) };
  for (const p of EXCLUDED_PATHS) delete paths[p];
  return { ...spec, paths };
}

const filtered = buildFilteredSpec();
writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
console.log(
  `wrote snapshot: ${SNAPSHOT_PATH} (paths: ${Object.keys(filtered.paths as object).join(", ")})`,
);

// openapi-typescript CLI: snapshot → generated types (types-only, no runtime dep).
const out = execFileSync("pnpm", ["exec", "openapi-typescript", SNAPSHOT_PATH, "-o", TYPES_PATH], {
  cwd: PKG_ROOT,
  encoding: "utf8",
});
console.log(out);
console.log(`wrote types: ${TYPES_PATH}`);
