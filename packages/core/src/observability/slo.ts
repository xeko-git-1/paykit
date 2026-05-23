/**
 * In-process SLO ring buffer — tracks webhook acceptance success rate over a
 * rolling 7-day window. No external timeseries DB dependency.
 *
 * Each sample: { timestamp, success: boolean }. snapshot() computes rate.
 *
 * Memory bound: `maxSamples` (default 100k). Older samples pruned on insert.
 */

export interface SloSample {
  readonly timestamp: number;
  readonly success: boolean;
}

export interface SloSnapshot {
  readonly window: string;
  readonly samples: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly successRate: number;
  readonly target: number;
  readonly meeting: boolean;
}

export interface SloConfig {
  readonly windowMs: number;
  readonly maxSamples: number;
  readonly targetRate: number;
}

const DEFAULT_CONFIG: SloConfig = {
  windowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxSamples: 100_000,
  targetRate: 0.999,
};

export class SloTracker {
  private samples: SloSample[] = [];
  private readonly config: SloConfig;

  constructor(config: Partial<SloConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  record(success: boolean, now = Date.now()): void {
    this.samples.push({ timestamp: now, success });
    if (this.samples.length > this.config.maxSamples) {
      this.samples.splice(0, this.samples.length - this.config.maxSamples);
    }
  }

  snapshot(now = Date.now()): SloSnapshot {
    const cutoff = now - this.config.windowMs;
    const recent = this.samples.filter((s) => s.timestamp >= cutoff);
    const successCount = recent.filter((s) => s.success).length;
    const failureCount = recent.length - successCount;
    const rate = recent.length === 0 ? 1 : successCount / recent.length;
    return {
      window: `${Math.round(this.config.windowMs / (24 * 60 * 60 * 1000))}d`,
      samples: recent.length,
      successCount,
      failureCount,
      successRate: rate,
      target: this.config.targetRate,
      meeting: rate >= this.config.targetRate,
    };
  }
}
