/**
 * GET /admin/webhook-events — debugging tool for ops to inspect webhook history.
 *   Query: provider (sepay|stripe), since (ISO datetime), limit, offset.
 *
 * GET /admin/reconciliation/runs — list past reconciliation worker runs.
 */
import type { AdminGuard } from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { listRuns } from "@xeko-git-1/paykit-auth-core/db/repos/reconciliation.repo.js";
import { listEvents } from "@xeko-git-1/paykit-auth-core/db/repos/webhook-event.repo.js";
import { Hono } from "hono";
import { z } from "zod";
import { dataJson, errorJson } from "../shared/response.js";
import { adminGuardMiddleware } from "./admin-guard.js";

const eventsQuerySchema = z.object({
  provider: z.enum(["sepay", "stripe"]).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface AdminWebhookEventsDeps {
  readonly db: DbClient;
  readonly adminGuard: AdminGuard;
}

export function buildAdminWebhookEventsRoute(deps: AdminWebhookEventsDeps): Hono {
  const app = new Hono();
  const { db, adminGuard } = deps;

  app.use("*", adminGuardMiddleware(adminGuard));

  app.get("/webhook-events", async (c) => {
    let q: z.infer<typeof eventsQuerySchema>;
    try {
      q = eventsQuerySchema.parse(c.req.query());
    } catch (err) {
      return errorJson(
        c,
        400,
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "invalid query",
      );
    }
    const events = await listEvents(db, {
      ...(q.provider !== undefined ? { provider: q.provider } : {}),
      ...(q.since !== undefined ? { since: new Date(q.since) } : {}),
      limit: q.limit,
      offset: q.offset,
    });
    return dataJson(c, {
      events: events.map((e) => ({
        provider: e.provider,
        eventId: e.eventId,
        recordedAt: e.recordedAt.toISOString(),
      })),
      pagination: { limit: q.limit, offset: q.offset },
    });
  });

  app.get("/reconciliation/runs", async (c) => {
    let q: z.infer<typeof runsQuerySchema>;
    try {
      q = runsQuerySchema.parse(c.req.query());
    } catch (err) {
      return errorJson(
        c,
        400,
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : "invalid query",
      );
    }
    const runs = await listRuns(db, { limit: q.limit, offset: q.offset });
    return dataJson(c, {
      runs: runs.map((r) => ({
        runId: r.runId,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        summaryJson: r.summaryJson,
      })),
      pagination: { limit: q.limit, offset: q.offset },
    });
  });

  return app;
}
