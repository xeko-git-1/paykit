import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = resolve(__dirname, "..", "..", "..", "packages");

const V1_5_PACKAGES = [
  "stripe-adapter",
  "sepay-adapter",
  "vnpay-adapter",
  "momo-adapter",
  "zalopay-adapter",
  "cli",
] as const;

const V2_PACKAGES = ["core", "server", "workers", "react", "stripe-subscription-adapter"] as const;

function readPkg(dir: string): {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(PKG_ROOT, dir, "package.json"), "utf8"));
}

describe("v0.2.1 hotfix V1.5 adapter version baseline (Phase 0a — RT F4)", () => {
  it.each(V1_5_PACKAGES)("%s is at 0.1.5 (no longer 0.0.0)", (pkg) => {
    const json = readPkg(pkg);
    expect(json.version).toBe("0.1.5");
  });

  it.each(V1_5_PACKAGES)(
    "%s declares peerDependency on @xeko-git-1/paykit with range >=0.1.5 <0.4.0",
    (pkg) => {
      const json = readPkg(pkg);
      expect(json.peerDependencies?.["@xeko-git-1/paykit"]).toBe(">=0.1.5 <0.4.0");
    },
  );

  it.each(V1_5_PACKAGES)(
    "%s no longer carries @xeko-git-1/paykit in dependencies (converted to peerDep)",
    (pkg) => {
      const json = readPkg(pkg);
      expect(json.dependencies?.["@xeko-git-1/paykit"]).toBeUndefined();
    },
  );
});

describe("v0.2.1 hotfix V2 package version bumps (Phase 0a — Val D5)", () => {
  // V2 packages may be at 0.2.1 (post-Phase-0a) OR 0.3.0-rc.0 (post-Phase-0b
  // core/server bump). Both are valid downstream states.
  it.each(V2_PACKAGES)("%s is at 0.2.1+ (bumped from 0.2.0-rc.0)", (pkg) => {
    const json = readPkg(pkg);
    expect(json.version).toMatch(/^0\.(2\.1|3\.0-rc\.[0-9]+)$/);
  });
});

describe("v0.2.1 hotfix package count (RT F4 + Val D5)", () => {
  it("11 packages publish in v0.2.1+: 6 V1.5 at 0.1.5 + 5 V2 at 0.2.1+", () => {
    const allVersions = [...V1_5_PACKAGES, ...V2_PACKAGES].map(readPkg).map((p) => p.version);
    expect(allVersions).toHaveLength(11);
    expect(allVersions.filter((v) => v === "0.1.5")).toHaveLength(6);
    expect(allVersions.filter((v) => /^0\.(2\.1|3\.0-rc\.[0-9]+)$/.test(v))).toHaveLength(5);
  });
});
