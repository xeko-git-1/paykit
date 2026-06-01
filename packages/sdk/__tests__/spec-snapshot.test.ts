/**
 * Spec-snapshot drift guard (F15).
 *
 * The committed openapi.json is the source of truth for the generated SDK types.
 * If the service's live spec changes (new endpoint, changed DTO) without the SDK
 * being regenerated, the SDK silently drifts. This test recomputes the expected
 * snapshot from the live service (getOpenAPIDocument, mint path filtered) and
 * asserts it byte-equals the committed file. On failure: run `sdk:generate`.
 *
 * Also asserts the security invariant directly: the snapshot must NOT contain the
 * jwt-plane mint route /v1/api-keys (F11).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOpenAPIDocument } from "@vibecc/paykit-service";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(HERE, "..", "openapi.json");

const EXCLUDED_PATHS = ["/v1/api-keys"];

function expectedSnapshot(): string {
  const spec = getOpenAPIDocument() as { paths?: Record<string, unknown> };
  const paths = { ...(spec.paths ?? {}) };
  for (const p of EXCLUDED_PATHS) delete paths[p];
  return `${JSON.stringify({ ...spec, paths }, null, 2)}\n`;
}

describe("OpenAPI snapshot (anti-drift, F15)", () => {
  it("committed openapi.json matches the live service spec (mint filtered)", () => {
    const committed = readFileSync(SNAPSHOT_PATH, "utf8");
    expect(committed).toBe(expectedSnapshot());
  });

  it("snapshot excludes the jwt-plane mint route /v1/api-keys (F11)", () => {
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as {
      paths: Record<string, unknown>;
    };
    expect(committed.paths["/v1/api-keys"]).toBeUndefined();
    // Sanity: the api-key-plane routes ARE present
    expect(committed.paths["/v1/checkouts"]).toBeDefined();
    expect(committed.paths["/v1/balances"]).toBeDefined();
    expect(committed.paths["/v1/payments"]).toBeDefined();
    expect(committed.paths["/v1/refunds"]).toBeDefined();
  });
});
