import { describe, expect, it } from "vitest";
import { SloTracker } from "../src/observability/slo.js";

describe("SloTracker", () => {
  it("starts at 100% with zero samples (no failures yet)", () => {
    const t = new SloTracker();
    const s = t.snapshot();
    expect(s.samples).toBe(0);
    expect(s.successRate).toBe(1);
    expect(s.meeting).toBe(true);
  });

  it("computes successRate from recorded samples", () => {
    const t = new SloTracker();
    for (let i = 0; i < 99; i++) t.record(true);
    t.record(false);
    const s = t.snapshot();
    expect(s.samples).toBe(100);
    expect(s.successCount).toBe(99);
    expect(s.failureCount).toBe(1);
    expect(s.successRate).toBe(0.99);
  });

  it("flags 'meeting=false' when below target (default 0.999)", () => {
    const t = new SloTracker();
    t.record(true);
    t.record(false);
    expect(t.snapshot().meeting).toBe(false);
  });

  it("excludes samples outside the 7-day window", () => {
    const t = new SloTracker();
    const now = Date.now();
    const oldSample = now - 8 * 24 * 60 * 60 * 1000;
    t.record(true, oldSample);
    t.record(true, oldSample);
    t.record(false, now);
    const s = t.snapshot(now);
    expect(s.samples).toBe(1);
    expect(s.successRate).toBe(0);
  });

  it("respects custom target", () => {
    const t = new SloTracker({ targetRate: 0.5 });
    t.record(true);
    t.record(false);
    expect(t.snapshot().meeting).toBe(true); // 0.5 = 0.5
  });

  it("prunes oldest samples beyond maxSamples", () => {
    const t = new SloTracker({ maxSamples: 100 });
    for (let i = 0; i < 200; i++) t.record(true);
    expect(t.snapshot().samples).toBe(100);
  });
});
