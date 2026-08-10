/**
 * Discount consume containment against a REAL Postgres.
 *
 * These invariants cannot be demonstrated with a mocked transaction, because the
 * thing under test IS Postgres behaviour:
 *
 *   - A statement that fails inside a transaction puts it in the aborted state
 *     (SQLSTATE 25P02: "current transaction is aborted, commands ignored until
 *     end of transaction block"). Every later statement fails too, so a
 *     "fall back to full price" path written on the same transaction cannot run.
 *   - ROLLBACK TO SAVEPOINT is what makes the transaction usable again, and is
 *     also what undoes a reservation that `consume` wrote before it failed.
 *
 * A fake tx object would happily accept statements after a simulated failure and
 * report success, which is precisely the bug these tests exist to catch.
 *
 * Gated by PAYKIT_E2E_DATABASE_URL, matching the service cold-start e2e.
 */
import type { AppliedDiscount } from "@xeko-git-1/paykit";
import { type DbClient, paykitDbSchema } from "@xeko-git-1/paykit-server";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyDiscountInTx } from "../src/routes/checkout/apply-discount.js";

const E2E_DB = process.env.PAYKIT_E2E_DATABASE_URL;
const maybe = E2E_DB ? describe : describe.skip;

maybe("discount consume containment (real Postgres)", () => {
  let pool: Pool;
  let db: DbClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: E2E_DB });
    db = drizzle(pool, { schema: paykitDbSchema }) as unknown as DbClient;
    // Stand-in for the consumer's discount table: this module never touches
    // paykit.discounts itself (the reservation lives behind consume()), so the
    // test owns a minimal table with the same reserve-counter shape.
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS discount_consume_probe (id text PRIMARY KEY, reserved int NOT NULL DEFAULT 0)`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS discount_consume_probe`);
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE discount_consume_probe`);
    await db.execute(sql`INSERT INTO discount_consume_probe (id, reserved) VALUES ('d1', 0)`);
  });

  async function reservedCount(): Promise<number> {
    const r = await db.execute<{ reserved: number }>(
      sql`SELECT reserved FROM discount_consume_probe WHERE id = 'd1'`,
    );
    return Number(r.rows[0]?.reserved ?? -1);
  }

  /** Reserves, then fails with a genuine SQL error — the poisoning case. */
  function discountFailingWithSqlErrorAfterReserving(): AppliedDiscount {
    return {
      percent: 10,
      code: "SQLFAIL",
      sourceId: "d1",
      consume: async (tx) => {
        const t = tx as DbClient;
        await t.execute(
          sql`UPDATE discount_consume_probe SET reserved = reserved + 1 WHERE id = 'd1'`,
        );
        await t.execute(sql`SELECT 1 / 0`);
        return true;
      },
    };
  }

  it("leaves the transaction usable after consume fails with a SQL error", async () => {
    const committed = await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: discountFailingWithSqlErrorAfterReserving(),
        tx,
        amountMicros: 1_000_000n,
      });
      expect(outcome.applied).toBe(false);
      expect(outcome.effectiveMicros).toBe(1_000_000n);

      // The whole point: this statement runs. Without the savepoint the
      // transaction would be aborted and this would throw 25P02.
      await tx.execute(
        sql`INSERT INTO discount_consume_probe (id, reserved) VALUES ('full-price-checkout', 0)`,
      );
      return "committed";
    });

    expect(committed).toBe("committed");
    const r = await db.execute<{ id: string }>(
      sql`SELECT id FROM discount_consume_probe WHERE id = 'full-price-checkout'`,
    );
    expect(r.rows).toHaveLength(1);
  });

  it("rolls back the reservation written before consume failed", async () => {
    await db.transaction(async (tx) => {
      await applyDiscountInTx({
        discount: discountFailingWithSqlErrorAfterReserving(),
        tx,
        amountMicros: 1_000_000n,
      });
    });
    // Charged full price, so the reservation must not have been spent.
    expect(await reservedCount()).toBe(0);
  });

  it("rolls back the reservation when consume writes then reports losing the race", async () => {
    await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: {
          percent: 25,
          code: "RACE",
          sourceId: "d1",
          consume: async (t) => {
            await (t as DbClient).execute(
              sql`UPDATE discount_consume_probe SET reserved = reserved + 1 WHERE id = 'd1'`,
            );
            return false;
          },
        },
        tx,
        amountMicros: 1_000_000n,
      });
      expect(outcome.reason).toBe("consume-lost");
      expect(outcome.effectiveMicros).toBe(1_000_000n);
    });
    expect(await reservedCount()).toBe(0);
  });

  it("keeps the reservation and the discount when consume succeeds", async () => {
    await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: {
          percent: 10,
          code: "OK",
          sourceId: "d1",
          consume: async (t) => {
            await (t as DbClient).execute(
              sql`UPDATE discount_consume_probe SET reserved = reserved + 1 WHERE id = 'd1'`,
            );
            return true;
          },
        },
        tx,
        amountMicros: 1_000_000n,
      });
      expect(outcome.applied).toBe(true);
      expect(outcome.effectiveMicros).toBe(900_000n);
    });
    expect(await reservedCount()).toBe(1);
  });

  it("does not touch the reservation when the percent is out of range", async () => {
    let consumeCalled = false;
    await db.transaction(async (tx) => {
      const outcome = await applyDiscountInTx({
        discount: {
          percent: 150,
          code: "BAD",
          sourceId: "d1",
          consume: async (t) => {
            consumeCalled = true;
            await (t as DbClient).execute(
              sql`UPDATE discount_consume_probe SET reserved = reserved + 1 WHERE id = 'd1'`,
            );
            return true;
          },
        },
        tx,
        amountMicros: 1_000_000n,
      });
      expect(outcome.reason).toBe("percent-out-of-range");
    });
    expect(consumeCalled).toBe(false);
    expect(await reservedCount()).toBe(0);
  });
});
