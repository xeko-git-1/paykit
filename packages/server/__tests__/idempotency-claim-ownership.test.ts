/**
 * Idempotency claims have an owner, and every write proves it still owns one.
 *
 * The defect these cover returns one request's response as the answer to another
 * request. A claim used to be identified by (tenant_id, key) plus
 * `state = 'in_flight'`, which cannot tell two claimants apart:
 *
 *   1. Request A claims the key and starts its handler.
 *   2. A's handler runs longer than the 120s in-flight TTL.
 *   3. Request B finds the row expired and reclaims it — same primary key, same
 *      state, B's own body hash.
 *   4. A finalizes. `state = 'in_flight'` matches B's row, so A's response is
 *      written into B's claim, and a caller polling that key reads A's response
 *      as the outcome of B's request.
 *
 * The release path had the same shape in reverse: A's rollback deleted B's live
 * claim, leaving the key looking untouched so a third request re-ran the mutation.
 *
 * So the assertions are about the guard itself, not just the happy path: a
 * finalize and a release must both be conditional on the claim token, and a
 * reclaim must mint a NEW token — a reclaim that reused the old one would leave
 * the stale claimant able to write to it.
 */
import * as idempotencyRepo from "@vibecc/paykit-auth-core/db/repos/idempotency.repo.js";
import { describe, expect, it } from "vitest";

const TENANT = "a0000000-0000-4000-8000-000000000001";
const KEY = "idem-key-1";
const TOKEN_A = "b0000000-0000-4000-8000-00000000000a";
const TOKEN_B = "b0000000-0000-4000-8000-00000000000b";

/**
 * The values bound into a Drizzle predicate, flattened so a guard is greppable.
 *
 * Only bound parameters are collected — walking the whole graph would pull in
 * column names (`claim_token` among them) and make an assertion about what a
 * guard binds pass for the wrong reason. Columns also point back at their table,
 * so the narrow walk is what terminates.
 */
function predicateValues(predicate: unknown): string {
  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if ("value" in rec && "encoder" in rec) {
      values.push(String(rec.value));
      return;
    }
    if (Array.isArray(rec.queryChunks)) {
      for (const chunk of rec.queryChunks) walk(chunk);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    }
  };
  walk(predicate);
  return values.join("|");
}

/** Records an UPDATE's patch and predicate; `rows` is what the guard returns. */
function updateSpy(rows: unknown[]) {
  const seen: { patch?: Record<string, unknown>; where?: unknown } = {};
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        seen.patch = patch;
        return {
          where: (predicate: unknown) => {
            seen.where = predicate;
            return { returning: async () => rows };
          },
        };
      },
    }),
  } as never;
  return { db, seen };
}

/** Records a DELETE's predicate; `rows` is what the guard removed. */
function deleteSpy(rows: unknown[]) {
  const seen: { where?: unknown } = {};
  const db = {
    delete: () => ({
      where: (predicate: unknown) => {
        seen.where = predicate;
        return { returning: async () => rows };
      },
    }),
  } as never;
  return { db, seen };
}

/**
 * A db whose INSERT ... ON CONFLICT DO NOTHING wins, echoing back the row it was
 * given so the caller's generated token is what comes out.
 */
function insertWinsDb() {
  const seen: { values?: Record<string, unknown> } = {};
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        seen.values = row;
        return {
          onConflictDoNothing: () => ({ returning: async () => [row] }),
        };
      },
    }),
  } as never;
  return { db, seen };
}

/**
 * A db whose insert loses the conflict, then reads back `existing`, then applies
 * the reclaim UPDATE — the path a request takes when it finds an expired claim.
 */
function insertLosesThenReclaimDb(existing: Record<string, unknown>, reclaimRows: unknown[]) {
  const seen: { patch?: Record<string, unknown>; where?: unknown } = {};
  const db = {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [existing] }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        seen.patch = patch;
        return {
          where: (predicate: unknown) => {
            seen.where = predicate;
            return { returning: async () => reclaimRows };
          },
        };
      },
    }),
  } as never;
  return { db, seen };
}

function doneRecord(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    idempotencyKey: KEY,
    provider: "stripe",
    routePath: "/v2/checkout",
    requestBodyHash: "hash-a",
    state: "done",
    claimToken: TOKEN_A,
    claimGeneration: 1,
    responseStatus: 200,
    responseBodyJson: { ok: true },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("winning a claim hands the caller its ownership token", () => {
  it("returns the token that was written, so finalize can prove ownership later", async () => {
    const { db, seen } = insertWinsDb();
    const result = await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-a",
    });

    expect(result.outcome).toBe("claimed");
    // Without a token on the result there is nothing for finalize to guard on,
    // which is the whole defect.
    if (result.outcome !== "claimed") throw new Error("expected a claim");
    expect(result.claimToken).toBeTypeOf("string");
    expect(result.claimToken.length).toBeGreaterThan(0);
    // The token handed back is the one persisted, not a second unrelated value.
    expect(result.claimToken).toBe(seen.values?.claimToken);
  });

  it("writes the claim as in_flight with a first generation", async () => {
    const { db, seen } = insertWinsDb();
    await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-a",
    });
    expect(seen.values?.state).toBe("in_flight");
    expect(seen.values?.claimGeneration).toBe(1);
    // No response yet — an in-flight claim that carried one would be replayable
    // before its handler had produced anything.
    expect(seen.values?.responseStatus).toBeNull();
  });
});

describe("reclaiming an expired claim takes ownership away from the previous holder", () => {
  const expired = doneRecord({
    state: "in_flight",
    claimToken: TOKEN_A,
    expiresAt: new Date(Date.now() - 60_000),
  });

  it("mints a NEW token rather than reusing the expired one", async () => {
    const reclaimedToken = TOKEN_B;
    const { db, seen } = insertLosesThenReclaimDb(expired, [
      { ...expired, claimToken: reclaimedToken },
    ]);
    const result = await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-b",
    });

    expect(result.outcome).toBe("claimed");
    // Reusing TOKEN_A would leave the previous, still-running claimant able to
    // finalize onto this claim — exactly what the token exists to prevent.
    expect(seen.patch?.claimToken).not.toBe(TOKEN_A);
    expect(seen.patch?.claimToken).toBeTypeOf("string");
  });

  it("returns the reclaimed row's token, not the one it generated", async () => {
    // The row is the authority: whoever's token is actually in the row owns the
    // claim, so that is what the caller must carry.
    const { db } = insertLosesThenReclaimDb(expired, [{ ...expired, claimToken: TOKEN_B }]);
    const result = await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-b",
    });
    if (result.outcome !== "claimed") throw new Error("expected a claim");
    expect(result.claimToken).toBe(TOKEN_B);
  });

  it("advances the generation so a reclaim is visible after the fact", async () => {
    const { db, seen } = insertLosesThenReclaimDb(expired, [{ ...expired, claimToken: TOKEN_B }]);
    await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-b",
    });
    // Not a guard — an incident question: was this key reclaimed, how often?
    expect(seen.patch?.claimGeneration).toBeDefined();
  });

  it("reports in_flight when another racer won the reclaim", async () => {
    // Two requests can both see the row expired; the expires_at guard lets only
    // one reclaim it, and the loser must not run the handler.
    const { db } = insertLosesThenReclaimDb(expired, []);
    const result = await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-b",
    });
    expect(result.outcome).toBe("in_flight");
  });
});

describe("finalizing is conditional on still owning the claim", () => {
  it("guards on the caller's claim token", async () => {
    const { db, seen } = updateSpy([doneRecord()]);
    await idempotencyRepo.finalizeIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
      responseStatus: 200,
      responseBody: { ok: true },
    });

    const guard = predicateValues(seen.where);
    // The token in the predicate is what stops a slow handler writing onto a
    // claim that was reclaimed out from under it.
    expect(guard).toContain(TOKEN_A);
    expect(guard).toContain(TENANT);
    expect(guard).toContain(KEY);
    expect(guard).toContain("in_flight");
  });

  it("returns null when the claim was reclaimed, instead of overwriting it", async () => {
    // No row matched: the token names a claim that no longer exists.
    const { db } = updateSpy([]);
    const result = await idempotencyRepo.finalizeIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
      responseStatus: 200,
      responseBody: { ok: true },
    });
    expect(result).toBeNull();
  });

  it("records the response and flips the row to done when the claim still holds", async () => {
    const { db, seen } = updateSpy([doneRecord()]);
    const result = await idempotencyRepo.finalizeIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
      responseStatus: 201,
      responseBody: { sessionId: "cs_1" },
    });

    expect(result).not.toBeNull();
    expect(seen.patch?.state).toBe("done");
    expect(seen.patch?.responseStatus).toBe(201);
    expect(seen.patch?.responseBodyJson).toEqual({ sessionId: "cs_1" });
  });

  it("does not write the claim token itself, so ownership cannot be reassigned by a finalize", async () => {
    const { db, seen } = updateSpy([doneRecord()]);
    await idempotencyRepo.finalizeIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
      responseStatus: 200,
      responseBody: {},
    });
    expect(seen.patch).not.toHaveProperty("claimToken");
  });
});

describe("releasing is conditional on still owning the claim", () => {
  it("guards on the caller's claim token", async () => {
    const { db, seen } = deleteSpy([doneRecord({ state: "in_flight" })]);
    await idempotencyRepo.releaseIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
    });

    const guard = predicateValues(seen.where);
    // Without the token, a failed slow handler deleted whichever claim currently
    // held the key — and a third request then re-ran the mutation.
    expect(guard).toContain(TOKEN_A);
    expect(guard).toContain(TENANT);
    expect(guard).toContain(KEY);
    expect(guard).toContain("in_flight");
  });

  it("reports true when it removed its own claim", async () => {
    const { db } = deleteSpy([doneRecord({ state: "in_flight" })]);
    const removed = await idempotencyRepo.releaseIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
    });
    expect(removed).toBe(true);
  });

  it("reports false when the claim had already been taken away", async () => {
    const { db } = deleteSpy([]);
    const removed = await idempotencyRepo.releaseIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
    });
    expect(removed).toBe(false);
  });
});

describe("the stale-claimant sequence end to end", () => {
  it("a finalize carrying the superseded token changes nothing", async () => {
    // A claims (token A). A's handler outlives the TTL. B reclaims, so the live
    // row now carries token B. A finalizes with token A: no row matches, so B's
    // claim keeps its own eventual response and A's client still gets A's.
    const { db, seen } = updateSpy([]);
    const result = await idempotencyRepo.finalizeIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
      responseStatus: 200,
      responseBody: { belongsTo: "A" },
    });

    expect(result).toBeNull();
    expect(predicateValues(seen.where)).toContain(TOKEN_A);
    expect(predicateValues(seen.where)).not.toContain(TOKEN_B);
  });

  it("a release carrying the superseded token does not delete the live claim", async () => {
    const { db } = deleteSpy([]);
    const removed = await idempotencyRepo.releaseIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      claimToken: TOKEN_A,
    });
    expect(removed).toBe(false);
  });
});

describe("an unexpired claim still behaves as before", () => {
  it("replays a finalized response", async () => {
    const live = doneRecord({ expiresAt: new Date(Date.now() + 3_600_000) });
    const db = {
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [live] }) }) }),
    } as never;

    const result = await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-a",
    });
    expect(result.outcome).toBe("replay");
  });

  it("rejects the same key submitted with a different body", async () => {
    const live = doneRecord({ expiresAt: new Date(Date.now() + 3_600_000) });
    const db = {
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [live] }) }) }),
    } as never;

    await expect(
      idempotencyRepo.claimIdempotency(db, {
        tenantId: TENANT,
        key: KEY,
        provider: "stripe",
        routePath: "/v2/checkout",
        bodyHash: "a-different-hash",
      }),
    ).rejects.toThrow(idempotencyRepo.IdempotencyBodyMismatchError);
  });

  it("reports in_flight for a live claim held by someone else", async () => {
    const live = doneRecord({
      state: "in_flight",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const db = {
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [live] }) }) }),
    } as never;

    const result = await idempotencyRepo.claimIdempotency(db, {
      tenantId: TENANT,
      key: KEY,
      provider: "stripe",
      routePath: "/v2/checkout",
      bodyHash: "hash-a",
    });
    expect(result.outcome).toBe("in_flight");
  });
});
