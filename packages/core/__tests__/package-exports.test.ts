import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verify each package's `package.json` exports field resolves to a real built artifact path
 * declaration (not the actual file existence at test time, since dist may be empty until build).
 * This guards against typos in `exports`, `main`, `types`, `files`.
 */
const PACKAGES = ["core", "server", "workers", "react", "cli"] as const;

interface PkgJson {
  readonly name: string;
  readonly version: string;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: string | Record<string, string>;
  readonly exports?: Record<string, { types?: string; import?: string }>;
  readonly files?: readonly string[];
  readonly publishConfig?: { registry?: string };
}

function readPkg(name: string): PkgJson {
  const path = resolve(__dirname, "..", "..", name, "package.json");
  return JSON.parse(readFileSync(path, "utf8")) as PkgJson;
}

describe("package exports contract", () => {
  for (const pkg of PACKAGES) {
    describe(pkg, () => {
      const json = readPkg(pkg);

      it("declares ESM type", () => {
        expect(json.type).toBe("module");
      });

      it("publishes to GitHub Packages registry", () => {
        expect(json.publishConfig?.registry).toBe("https://npm.pkg.github.com");
      });

      it("includes dist/ in files", () => {
        expect(json.files).toBeDefined();
        expect(json.files).toContain("dist");
      });

      if (pkg !== "cli") {
        it("has typed ESM exports map", () => {
          expect(json.exports?.["."]).toBeDefined();
          expect(json.exports?.["."]?.types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
          expect(json.exports?.["."]?.import).toMatch(/^\.\/dist\/.*\.js$/);
        });
      }

      if (pkg === "cli") {
        it("declares paykit bin", () => {
          const bin = typeof json.bin === "object" ? json.bin?.paykit : undefined;
          expect(bin).toBeDefined();
          expect(bin).toMatch(/^\.\/dist\/.*\.js$/);
        });
      }
    });
  }
});
