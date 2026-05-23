import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * V1 boundary guard: ensure no Subscription / VibeCC-specific code leaks in.
 * These greps run against published artifact source dirs.
 */
const FORBIDDEN_PATTERNS = [
  // V1 → V2 boundary
  /mode:\s*["']subscription["']/,
  /Stripe\.Subscription/,
  /Stripe\.Customer/,
  /Stripe\.Price/,
  /Stripe\.Product/,
  // VibeCC-specific terms
  /workspace_id/,
  /organization_id/,
  /creditPool/,
  /credit_pool/,
  // Promo code (must use discountResolver hook only)
  /promoCodeRepo/,
  /promo_codes/,
];

const SRC_DIRS = [
  "packages/core/src",
  "packages/server/src",
  "packages/workers/src",
  "packages/react/src",
  "packages/cli/src",
];

import { execSync } from "node:child_process";

const ROOT = resolve(__dirname, "..", "..", "..");

function searchPattern(dir: string, pattern: RegExp): string[] {
  const fullDir = resolve(ROOT, dir);
  if (!existsSync(fullDir)) return [];
  try {
    const out = execSync(
      `find ${fullDir} -name '*.ts' -o -name '*.tsx' 2>/dev/null | xargs grep -lE ${JSON.stringify(pattern.source)} 2>/dev/null || true`,
      { encoding: "utf8" },
    );
    return out.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

describe("V1 boundary guards (no Subscription / VibeCC bleed)", () => {
  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`no occurrences of ${pattern.source}`, () => {
      const allMatches: string[] = [];
      for (const dir of SRC_DIRS) {
        allMatches.push(...searchPattern(dir, pattern));
      }
      expect(allMatches, `forbidden pattern leaked:\n${allMatches.join("\n")}`).toEqual([]);
    });
  }
});
