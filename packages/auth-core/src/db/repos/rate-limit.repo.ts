/**
 * rate-limit.repo — the one statement that makes the limit hold everywhere.
 *
 * Fixed-window counting as a single UPSERT: insert the credential's row for
 * this window, or — if a row exists — increment when it is the same window and
 * reset to 1 when the window has rolled over. Because both arms are one
 * statement, concurrent requests across any number of instances serialize on
 * the row and the returned count is exact; there is no read-modify-write gap
 * for two requests to slip through together.
 *
 * The count includes rejected requests on purpose: a client hammering past the
 * limit keeps its window saturated instead of being re-admitted the moment the
 * counter would have decayed.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { rateLimitWindows } from "../schema/rate-limit-windows.js";

/**
 * Count this request against the credential's current window and return the
 * total observed in that window (this request included). The caller compares
 * against its budget: `count > max` → reject.
 */
export async function consumeFixedWindow(
  db: DbOrTx,
  opts: { bucketKey: string; windowStart: Date },
): Promise<number> {
  const rows = await db
    .insert(rateLimitWindows)
    .values({ bucketKey: opts.bucketKey, windowStart: opts.windowStart, requestCount: 1 })
    .onConflictDoUpdate({
      target: rateLimitWindows.bucketKey,
      set: {
        // Same window → increment; a newer window → reset to 1. An OLDER
        // window (clock skew between instances) also matches the else-arm,
        // which forgives rather than punishes: the skewed instance starts a
        // fresh count instead of inheriting one it cannot interpret.
        requestCount: sql`CASE WHEN ${rateLimitWindows.windowStart} = excluded.window_start THEN ${rateLimitWindows.requestCount} + 1 ELSE 1 END`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ requestCount: rateLimitWindows.requestCount });

  const row = rows[0];
  if (row === undefined) {
    throw new Error("rate-limit.repo.consumeFixedWindow: upsert returned no row");
  }
  return row.requestCount;
}
