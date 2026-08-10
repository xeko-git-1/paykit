import type { DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import * as merchantRepo from "@xeko-git-1/paykit-auth-core/db/repos/merchant.repo.js";
/**
 * merchant.repo unit tests — insert/findById round-trip + list, against an
 * in-memory Drizzle-shaped handle (live-DB integration is gated separately).
 */
import { getTableName } from "drizzle-orm";
import { describe, expect, expectTypeOf, it } from "vitest";

type Row = Record<string, unknown>;

function thenable<T>(value: T): T & PromiseLike<T> {
  const out = (Array.isArray(value) ? [...(value as unknown[])] : { ...(value as object) }) as T &
    PromiseLike<T>;
  (out as { then: PromiseLike<T>["then"] }).then = (resolve, reject) =>
    Promise.resolve(value).then(resolve, reject);
  return out;
}

function makeDb(rows: Row[]) {
  return {
    insert(table: unknown) {
      void getTableName(table as never);
      return {
        values(rec: Row) {
          return {
            returning() {
              const row = {
                merchantId: crypto.randomUUID(),
                status: "active",
                createdAt: new Date(),
                updatedAt: new Date(),
                ...rec,
              };
              rows.push(row);
              return thenable([row]);
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          const builder = thenable(rows) as unknown as Row[] & { where: (c?: unknown) => unknown };
          builder.where = (cond?: unknown) => {
            // crude id filter: tests pass a single seeded merchant
            const afterWhere = thenable(rows) as unknown as Row[] & {
              limit: (n: number) => unknown;
            };
            afterWhere.limit = (n: number) => thenable(rows.slice(0, n));
            return afterWhere;
          };
          return builder;
        },
      };
    },
  } as unknown as DbOrTx;
}

describe("merchantRepo public API", () => {
  it("exposes insert/findById/list", () => {
    expect(typeof merchantRepo.insert).toBe("function");
    expect(typeof merchantRepo.findById).toBe("function");
    expect(typeof merchantRepo.list).toBe("function");
  });

  it("insert first arg accepts DbOrTx", () => {
    expectTypeOf(merchantRepo.insert).parameter(0).toEqualTypeOf<DbOrTx>();
  });
});

describe("merchantRepo behavior", () => {
  it("insert then findById round-trips the row", async () => {
    const rows: Row[] = [];
    const db = makeDb(rows);
    const created = await merchantRepo.insert(db, { name: "Acme Co" });
    expect(created.merchantId).toBeTruthy();
    expect(created.name).toBe("Acme Co");

    const found = await merchantRepo.findById(db, created.merchantId);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Acme Co");
  });

  it("findById returns null when no row exists", async () => {
    const db = makeDb([]);
    const found = await merchantRepo.findById(db, "missing");
    expect(found).toBeNull();
  });

  it("list returns all merchants", async () => {
    const rows: Row[] = [];
    const db = makeDb(rows);
    await merchantRepo.insert(db, { name: "A" });
    await merchantRepo.insert(db, { name: "B" });
    const all = await merchantRepo.list(db);
    expect(all).toHaveLength(2);
  });
});
