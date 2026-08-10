import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforce package boundary rules:
 * - react/src/** must NEVER import from server/src/** (admin UI is API-driven via fetch only)
 * - cli/src/** must NEVER import from server/src/** (CLI must not bundle the HTTP layer)
 * - core/src/** must NEVER import from any other workspace package (zero deps invariant)
 */

const ROOT = resolve(__dirname, "..", "..", "..");

function grepImports(searchPath: string, forbiddenPattern: string): string[] {
  try {
    // Match real import statements only (line starts with `import` keyword), not
    // string literals inside console.log or comments.
    const out = execSync(
      `grep -rEn "^[[:space:]]*(import|export)[[:space:]].*from[[:space:]]+['\\"]${forbiddenPattern}['\\"]" ${searchPath} || true`,
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    return out.split("\n").filter((line) => line.length > 0 && !line.includes("/__tests__/"));
  } catch {
    return [];
  }
}

describe("no cross-package forbidden imports", () => {
  it("react does not import from server", () => {
    const matches = grepImports("packages/react/src", "@xeko-git-1/paykit-server");
    expect(matches, matches.join("\n")).toEqual([]);
  });

  // CLI must not bundle the HTTP layer. It reuses auth primitives + repos via
  // @xeko-git-1/paykit-auth-core (the HTTP-free lower tier), never from server.
  it("cli does not import from server", () => {
    const matches = grepImports("packages/cli/src", "@xeko-git-1/paykit-server");
    expect(matches, matches.join("\n")).toEqual([]);
  });

  // auth-core is the HTTP-free foundation: it must never import the HTTP server.
  it("auth-core does not import from server", () => {
    const matches = grepImports("packages/auth-core/src", "@xeko-git-1/paykit-server");
    expect(matches, matches.join("\n")).toEqual([]);
  });

  it("core does not import from server, workers, react, or cli", () => {
    const targets = [
      "@xeko-git-1/paykit-server",
      "@xeko-git-1/paykit-workers",
      "@xeko-git-1/paykit-react",
      "@xeko-git-1/paykit-cli",
    ];
    for (const target of targets) {
      const matches = grepImports("packages/core/src", target);
      expect(matches, `${target}: ${matches.join("\n")}`).toEqual([]);
    }
  });

  it("workers does not import from react or cli", () => {
    // workers IS allowed to import DbClient + schema types from server (it's a peer of server,
    // not a layer above). Forbidden: react (DOM-only) and cli (process-level).
    const targets = ["@xeko-git-1/paykit-react", "@xeko-git-1/paykit-cli"];
    for (const target of targets) {
      const matches = grepImports("packages/workers/src", target);
      expect(matches, `${target}: ${matches.join("\n")}`).toEqual([]);
    }
  });
});
