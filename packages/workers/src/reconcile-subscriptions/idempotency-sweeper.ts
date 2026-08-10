/**
 * Pass C — Idempotency-records TTL sweeper (RT F6).
 *
 * Run by the V2 reconciler orchestrator after Pass A + Pass B. Removes
 * idempotency-records with `expires_at < now`. Pure repo wrapper — kept in
 * its own file to satisfy the 200-LOC ceiling.
 */
import { idempotencyRepo, type DbClient } from "@xeko-git-1/paykit-server";

export interface SweepIdempotencyResult {
  readonly deletedCount: number;
}

export async function sweepIdempotencyExpired(
  db: DbClient,
  now: Date = new Date(),
): Promise<SweepIdempotencyResult> {
  const deleted = await idempotencyRepo.sweepExpired(db, now);
  return { deletedCount: deleted };
}
