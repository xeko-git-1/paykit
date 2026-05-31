/**
 * Health check routes — liveness and readiness probes.
 *
 * /healthz: liveness probe, DB-independent. If the process is alive and
 * can serve HTTP, it returns 200. A slow or unreachable DB must NOT cause
 * pod restarts via this endpoint.
 *
 * /readyz: readiness probe. Pings DB with a cheap SELECT 1, bounded by a
 * 2-second timeout and cached for 5 seconds to prevent cascade when DB is
 * under pressure.
 */
import { Hono } from "hono";
import type { Pool } from "pg";

export interface HealthDeps {
  /** Raw pg Pool for readiness check (not Drizzle — we need raw query with timeout). */
  readonly pool: Pool | null;
}

interface ReadinessCache {
  ok: boolean;
  checkedAt: number;
}

const READINESS_CACHE_TTL_MS = 5_000;
const READINESS_TIMEOUT_MS = 2_000;

export function buildHealthRoutes(deps: HealthDeps): Hono {
  const app = new Hono();
  let readinessCache: ReadinessCache | null = null;

  // Liveness — no DB dependency, no secrets leaked
  app.get("/healthz", (c) => {
    return c.json({ status: "ok" }, 200);
  });

  // Readiness — DB ping with timeout + cache
  app.get("/readyz", async (c) => {
    // Return cached result if fresh
    if (readinessCache && Date.now() - readinessCache.checkedAt < READINESS_CACHE_TTL_MS) {
      return c.json(
        { status: readinessCache.ok ? "ready" : "not_ready" },
        readinessCache.ok ? 200 : 503,
      );
    }

    if (!deps.pool) {
      readinessCache = { ok: false, checkedAt: Date.now() };
      return c.json({ status: "not_ready" }, 503);
    }

    try {
      // Race the DB ping against a timeout
      const pingResult = await Promise.race([
        deps.pool.query("SELECT 1"),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), READINESS_TIMEOUT_MS),
        ),
      ]);

      const ok = pingResult !== "timeout";
      readinessCache = { ok, checkedAt: Date.now() };
      return c.json({ status: ok ? "ready" : "not_ready" }, ok ? 200 : 503);
    } catch {
      readinessCache = { ok: false, checkedAt: Date.now() };
      return c.json({ status: "not_ready" }, 503);
    }
  });

  return app;
}
