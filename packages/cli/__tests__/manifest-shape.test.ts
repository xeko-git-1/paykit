import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationManifest } from "../src/lib/manifest-types.js";

describe("paykit migrations bundle", () => {
  it("manifest.json declares schema='paykit' and includes 001_init", () => {
    const path = resolve(__dirname, "..", "..", "..", "migrations", "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as MigrationManifest;
    expect(manifest.schema).toBe("paykit");
    expect(manifest.advisoryLockKey).toBe("paykit.migrate");
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(1);
    expect(manifest.migrations[0]?.id).toBe("001");
  });
});
