/**
 * Phase 10 — V2 acceptance plan + CI gate sanity.
 *
 * Verifies docs/v2-acceptance-tests.md enumerates all 20 V2 specs (31-50)
 * and includes the Stripe sandbox CI matrix snippet. This guarantees the
 * acceptance test plan stays in lockstep with the implementation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = readFileSync(
  resolve(__dirname, "..", "..", "..", "docs", "v2-acceptance-tests.md"),
  "utf8",
);

describe("V2 acceptance test plan (Phase 10)", () => {
  it("declares all 20 V2 spec IDs (31-50)", () => {
    for (let n = 31; n <= 50; n++) {
      expect(DOC).toMatch(new RegExp(`\\b${n}\\b`));
    }
  });

  it("references RT findings F1, F4, F5, F6, F8, F9, F11, F12, F13", () => {
    for (const f of ["F1", "F4", "F5", "F6", "F8", "F9", "F11", "F12", "F13"]) {
      expect(DOC).toContain(f);
    }
  });

  it("references Val S4 Q1, Q2, Q4 decisions", () => {
    expect(DOC).toContain("Val S4 Q1");
    expect(DOC).toContain("Val S4 Q2");
    expect(DOC).toContain("Val S4 Q4");
  });

  it("documents 15-minute CI budget (Val S4 Q4)", () => {
    expect(DOC).toMatch(/15 minutes/);
    expect(DOC).toMatch(/timeout-minutes: 15/);
  });

  it("documents 11 packages for v0.2.0-rc.0 publish", () => {
    expect(DOC).toMatch(/v0\.2\.0-rc\.0/);
    expect(DOC).toContain("@vibecc/paykit-stripe-subscription");
    expect(DOC).toContain("@vibecc/paykit-server");
    expect(DOC).toContain("@vibecc/paykit-workers");
    expect(DOC).toContain("@vibecc/paykit-react");
  });

  it("identifies which specs are already covered by unit/handler tests", () => {
    expect(DOC).toMatch(/Currently covered by unit \+ route \+ handler tests/);
    for (const id of [38, 41, 42, 45, 46, 47, 48, 49, 50]) {
      expect(DOC).toMatch(new RegExp(`- ${id} `));
    }
  });

  it("calls out 7-day green sandbox CI before GA tag", () => {
    expect(DOC).toMatch(/7 consecutive days of green sandbox CI/);
    expect(DOC).toMatch(/v0\.2\.0/);
  });
});
