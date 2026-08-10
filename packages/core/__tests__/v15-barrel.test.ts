import { describe, expect, it } from "vitest";
import * as paykit from "../src/index.js";

describe("@xeko-git-1/paykit V1.5 barrel exports", () => {
  it("exports adapter types", () => {
    // Type-only exports — verify symbols exist via runtime barrel.
    expect("ProviderRegistry" in paykit).toBe(true);
  });

  it("exports ProviderRegistry class constructor", () => {
    expect(typeof paykit.ProviderRegistry).toBe("function");
  });

  it("preserves V1 exports (regression guard)", () => {
    expect(typeof paykit.PaykitError).toBe("function");
    expect(typeof paykit.EnvSecretProvider).toBe("function");
    expect(typeof paykit.microsStringToBigInt).toBe("function");
    expect(typeof paykit.vndToMicros).toBe("function");
  });
});
