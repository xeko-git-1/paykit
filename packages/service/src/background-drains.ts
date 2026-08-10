/**
 * The periodic work the service must do for its durable queues to mean anything.
 *
 * Two queues in this system are only safe because something comes back for them
 * later:
 *
 *   - The webhook inbox parks a delivery it could not match — most often because
 *     the checkout had not yet committed its provider reference. Nothing on the
 *     request path returns for it.
 *   - A compliance screening whose verdict was inconclusive is retried on a
 *     backoff, and the payment stays uncredited until it lands.
 *
 * Without a tick, both states are terminal in practice: a paid customer is never
 * credited and no error is ever raised. That is the exact failure the inbox was
 * built to remove, so leaving the tick as a deployment step nobody is told about
 * would reintroduce it — visible in a table this time, which is better, but still
 * lost money. It runs in-process by default instead.
 *
 * In-process rather than a separate cron image because the claim is a guarded
 * UPDATE: several instances ticking concurrently divide the work rather than
 * duplicating it, so "every replica also drains" is a safe default and needs no
 * coordination. An operator who prefers an external scheduler sets the interval to
 * 0 and calls the exported drains directly.
 */
import type { ScreeningService } from "@xeko-git-1/paykit";
import {
  type DbClient,
  type PaykitEventHandlers,
  drainScreeningJobs,
  drainWebhookInbox,
  sweepWebhookInbox,
} from "@xeko-git-1/paykit-server";

export interface BackgroundDrainDeps {
  readonly db: DbClient;
  readonly events?: PaykitEventHandlers;
  readonly screeningService?: ScreeningService;
  /** False only for payer-controlled rails; resolved per provider by the caller. */
  readonly settlesExactAmount?: (provider: string) => boolean;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
}

export interface BackgroundDrainOptions {
  /** Milliseconds between ticks. 0 disables the loop entirely. */
  readonly intervalMs?: number;
  /** Deliveries processed per tick — bounds how long one tick can run. */
  readonly maxPerTick?: number;
  /** Ticks between payload retention sweeps; the sweep is cheap but not free. */
  readonly sweepEveryTicks?: number;
}

/**
 * 15 seconds: fast enough that a webhook which raced its checkout is credited
 * while the customer is still watching, slow enough to be a negligible query load
 * when the queue is empty (one indexed claim that matches nothing).
 */
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_PER_TICK = 50;
/** ~1 hour at the default interval. */
const DEFAULT_SWEEP_EVERY_TICKS = 240;

export interface BackgroundDrains {
  /** Run one tick immediately — the unit a external scheduler would call. */
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export function startBackgroundDrains(
  deps: BackgroundDrainDeps,
  opts: BackgroundDrainOptions = {},
): BackgroundDrains {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const sweepEvery = opts.sweepEveryTicks ?? DEFAULT_SWEEP_EVERY_TICKS;

  let ticks = 0;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    // A tick that overruns its interval must not stack: two overlapping drains
    // would claim different rows (the guard makes that safe) but would double the
    // connection demand for no gain, and a slow database is exactly when that
    // matters.
    if (running) return;
    running = true;
    try {
      await drainWebhookInbox(
        {
          db: deps.db,
          events: deps.events ?? {},
          screeningConfigured: deps.screeningService !== undefined,
          settlesExactAmount: deps.settlesExactAmount ?? (() => true),
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
          ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
        },
        maxPerTick,
      );

      if (deps.screeningService !== undefined) {
        await drainScreeningJobs({
          db: deps.db,
          screeningService: deps.screeningService,
          events: deps.events ?? {},
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
          ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
        });
      }

      ticks += 1;
      if (sweepEvery > 0 && ticks % sweepEvery === 0) {
        await sweepWebhookInbox({ db: deps.db });
      }
    } catch (err) {
      // A throw here must not kill the interval, or one transient database error
      // silently ends all background processing for the life of the process — and
      // nothing would report it, because the queues simply stop being drained.
      deps.logger?.warn("background drain tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  if (intervalMs > 0) {
    timer = setInterval(() => void tick(), intervalMs);
    // Never hold the event loop open: a process that has been asked to exit should
    // not wait on a scheduler.
    timer.unref?.();
  }

  return {
    tick,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
